#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


/**
 * OpenCode Model Detector
 * 
 * 可靠地获取当前OpenCode会话的模型配置（providerID, modelID, API key, base URL）
 * 使用目录精确匹配方法确定当前session，不依赖猜测或假设。
 * 
 * 使用方法：
 * 1. 在skill脚本中：const detector = require('./opencode-model-detector.js');
 * 2. 获取配置：const config = detector.getCurrentModelConfig();
 * 3. 使用配置进行API调用
 * 
 * 特性：
 * - 不依赖环境变量猜测
 * - 不假设第一个session是当前的
 * - 通过目录精确匹配确定当前session
 * - 三级回退策略确保可靠性
 * - 提供清晰的错误信息和调试输出
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class OpenCodeModelDetector {
  constructor(options = {}) {
    this.options = {
      debug: options.debug || false,
      silent: options.silent || false,
      ...options
    };
    
    this.home = os.homedir();
    this.cwd = process.cwd();
    this.opencodeDir = path.join(this.home, '.local', 'share', 'opencode');
    this.authFile = path.join(this.opencodeDir, 'auth.json');
    this.storageBase = path.join(this.opencodeDir, 'storage', 'message');
    
    if (this.options.debug) {
      this._log('初始化 OpenCode Model Detector', 'debug');
      this._log(`工作目录: ${this.cwd}`, 'debug');
      this._log(`OpenCode目录: ${this.opencodeDir}`, 'debug');
    }
  }

  // ==================== 公共API ====================

  /**
   * 获取当前模型配置（主方法）
   * @returns {Object} 模型配置对象
   */
  getCurrentModelConfig() {
    try {
      if (this.options.debug) {
        this._log('开始获取当前模型配置...', 'debug');
      }
      
      // 1. 确定当前session
      const sessionInfo = this._getCurrentSessionInfo();
      if (!sessionInfo.success) {
        throw new Error(`无法确定当前session: ${sessionInfo.error}`);
      }
      
      if (this.options.debug) {
        this._log(`找到当前session: ${sessionInfo.session.title} (${sessionInfo.session.id})`, 'debug');
      }
      
      // 2. 获取该session的模型信息
      const modelInfo = this._getModelInfoForSession(sessionInfo.session.id);
      if (!modelInfo.success) {
        throw new Error(`无法获取模型信息: ${modelInfo.error}`);
      }
      
      if (this.options.debug) {
        this._log(`找到模型信息: ${modelInfo.providerID}/${modelInfo.modelID}`, 'debug');
      }
      
      // 3. 获取API key
      const authInfo = this._getAuthInfo(modelInfo.providerID);
      
      // 4. 构建配置对象
      const config = {
        success: true,
        providerID: modelInfo.providerID,
        modelID: modelInfo.modelID,
        apiKey: authInfo.apiKey,
        baseUrl: authInfo.baseUrl || this._getDefaultBaseUrl(modelInfo.providerID),
        sessionId: sessionInfo.session.id,
        sessionTitle: sessionInfo.session.title,
        directory: sessionInfo.session.directory,
        detectionMethod: sessionInfo.method,
        confidence: sessionInfo.confidence,
        timestamp: new Date().toISOString(),
        source: 'opencode-model-detector'
      };
      
      // 5. 验证配置完整性
      const validation = this._validateConfig(config);
      if (!validation.valid) {
        config.warnings = validation.warnings;
      }
      
      if (this.options.debug) {
        this._log('模型配置获取成功', 'debug');
      }
      return config;
      
    } catch (error) {
      this._log(`获取失败: ${error.message}`, 'error');
      
      // 返回错误信息
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
        suggestions: this._getErrorSuggestions(error)
      };
    }
  }

  /**
   * 快速获取当前模型名（简化版）
   * @returns {string} providerID/modelID 或错误信息
   */
  getCurrentModelString() {
    const config = this.getCurrentModelConfig();
    if (config.success) {
      return `${config.providerID}/${config.modelID}`;
    }
    return `错误: ${config.error}`;
  }

  /**
   * 获取当前API key（简化版）
   * @returns {string} API key 或 null
   */
  getCurrentApiKey() {
    const config = this.getCurrentModelConfig();
    return config.success ? config.apiKey : null;
  }

  /**
   * 验证配置是否可用于API调用
   * @returns {Object} 验证结果
   */
  validateForApiUse() {
    const config = this.getCurrentModelConfig();
    
    if (!config.success) {
      return {
        valid: false,
        reason: `配置获取失败: ${config.error}`,
        config: config
      };
    }
    
    const missing = [];
    if (!config.providerID) missing.push('providerID');
    if (!config.modelID) missing.push('modelID');
    if (!config.apiKey) missing.push('apiKey');
    if (!config.baseUrl) missing.push('baseUrl');
    
    return {
      valid: missing.length === 0,
      missing: missing,
      ready: missing.length === 0,
      config: config,
      message: missing.length === 0 
        ? '✅ 配置完整，可用于API调用'
        : `❌ 配置不完整，缺少: ${missing.join(', ')}`
    };
  }

  // ==================== 内部方法 ====================

  /**
   * 确定当前session（核心方法）
   */
  _getCurrentSessionInfo() {
    const methods = [
      { name: 'directory-exact', fn: this._detectSessionByDirectoryExact.bind(this), weight: 3 },
      { name: 'directory-parent', fn: this._detectSessionByDirectoryParent.bind(this), weight: 2 },
      { name: 'message-path', fn: this._detectSessionByMessagePath.bind(this), weight: 2 },
      { name: 'cli-first', fn: this._detectSessionByCliFirst.bind(this), weight: 1 }
    ];
    
    for (const method of methods) {
      try {
        const result = method.fn();
        if (result && result.session) {
          if (this.options.debug) {
            this._log(`使用 ${method.name} 方法找到session`, 'debug');
          }
          return {
            success: true,
            session: result.session,
            method: method.name,
            confidence: result.confidence || 'medium',
            reason: result.reason || `通过 ${method.name} 找到`
          };
        }
      } catch (error) {
        if (this.options.debug) {
          this._log(`方法 ${method.name} 失败: ${error.message}`, 'debug');
        }
      }
    }
    
    return {
      success: false,
      error: '无法找到匹配当前目录的session',
      suggestions: [
        '确认当前目录有OpenCode会话',
        '检查 ~/.local/share/opencode/storage/message/ 目录',
        '尝试运行 opencode session list 查看可用会话'
      ]
    };
  }

  /**
   * 方法1: 目录精确匹配
   */
  _detectSessionByDirectoryExact() {
    const sessions = this._getSessionsFromCLI();
    const exactMatch = sessions.find(s => s.directory === this.cwd);
    
    if (exactMatch) {
      return {
        session: exactMatch,
        confidence: 'high',
        reason: `目录精确匹配: ${this.cwd}`
      };
    }
    
    return null;
  }

  /**
   * 方法2: 父目录匹配
   */
  _detectSessionByDirectoryParent() {
    const sessions = this._getSessionsFromCLI();
    const parentMatch = sessions.find(s => 
      s.directory && this.cwd.startsWith(s.directory + path.sep)
    );
    
    if (parentMatch) {
      return {
        session: parentMatch,
        confidence: 'high',
        reason: `父目录匹配: ${this.cwd} 在 ${parentMatch.directory} 下`
      };
    }
    
    return null;
  }

  /**
   * 方法3: 消息文件路径匹配
   */
  _detectSessionByMessagePath() {
    if (!fs.existsSync(this.storageBase)) return null;
    
    const messages = this._getAllMessageFiles();
    const matchingMessages = messages.filter(msg => 
      msg.data.path && msg.data.path.cwd === this.cwd
    );
    
    if (matchingMessages.length > 0) {
      matchingMessages.sort((a, b) => b.mtime - a.mtime);
      const latestMessage = matchingMessages[0];
      
      const sessions = this._getSessionsFromCLI();
      const session = sessions.find(s => s.id === latestMessage.data.sessionID);
      
      if (session) {
        return {
          session: session,
          confidence: 'high',
          reason: `消息文件路径匹配: ${latestMessage.data.path.cwd}`,
          messageTime: new Date(latestMessage.mtime).toISOString()
        };
      }
    }
    
    return null;
  }

  /**
   * 方法4: CLI第一个session（回退）
   */
  _detectSessionByCliFirst() {
    const sessions = this._getSessionsFromCLI();
    if (sessions.length > 0) {
      return {
        session: sessions[0],
        confidence: 'low',
        reason: '使用CLI返回的第一个session',
        warning: '这可能不是当前活跃的session，仅作为回退方案'
      };
    }
    
    return null;
  }

  /**
   * 获取session的模型信息
   */
  _getModelInfoForSession(sessionId) {
    const sessionDir = path.join(this.storageBase, sessionId);
    
    // 方法1: 从session目录的消息文件中获取
    if (fs.existsSync(sessionDir)) {
      // 查找该session的所有消息文件
      const messageFiles = fs.readdirSync(sessionDir)
        .filter(f => f.startsWith('msg_') && f.endsWith('.json'))
        .map(f => ({
          name: f,
          path: path.join(sessionDir, f),
          mtime: fs.statSync(path.join(sessionDir, f)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);
      
      if (messageFiles.length > 0) {
        // 查找包含模型信息的消息
        for (const file of messageFiles) {
          try {
            const data = JSON.parse(fs.readFileSync(file.path, 'utf8'));
            if (data.providerID && data.modelID) {
              return {
                success: true,
                providerID: data.providerID,
                modelID: data.modelID,
                sourceFile: file.name,
                role: data.role,
                timestamp: new Date(file.mtime).toISOString(),
                source: 'message-file'
              };
            }
          } catch (error) {
            // 跳过无法解析的文件
            continue;
          }
        }
        
        return {
          success: false,
          error: `Session中没有找到模型信息: ${sessionId}`,
          suggestion: 'Session有消息文件但没有模型信息，尝试发送一条消息'
        };
      }
    }
    
    // 方法2: 从所有消息文件中查找（回退方案）
    if (this.options.debug) {
      this._log(`Session目录不存在或为空，尝试从所有消息文件中查找: ${sessionId}`, 'debug');
    }
    
    const allMessages = this._getAllMessageFiles();
    const sessionMessages = allMessages.filter(msg => msg.session === sessionId);
    
    if (sessionMessages.length > 0) {
      // 查找包含模型信息的消息
      for (const msg of sessionMessages) {
        if (msg.data.providerID && msg.data.modelID) {
          return {
            success: true,
            providerID: msg.data.providerID,
            modelID: msg.data.modelID,
            sourceFile: msg.file,
            role: msg.data.role,
            timestamp: new Date(msg.mtime).toISOString(),
            source: 'all-messages-scan'
          };
        }
      }
    }
    
    // 方法3: 从环境变量获取（最后回退）
    const envModel = process.env.OPENCODE_MODEL;
    if (envModel) {
      const parts = envModel.split('/');
      if (parts.length === 2) {
        return {
          success: true,
          providerID: parts[0],
          modelID: parts[1],
          source: 'environment-variable',
          warning: '使用环境变量中的模型配置，可能不是当前会话的准确配置'
        };
      }
    }
    
    // 方法4: 从最近的活跃session中获取（紧急回退）
    if (allMessages.length > 0) {
      // 查找最近的消息文件
      const recentMessages = allMessages.filter(msg => msg.data.providerID && msg.data.modelID);
      if (recentMessages.length > 0) {
        const recent = recentMessages[0];
        return {
          success: true,
          providerID: recent.data.providerID,
          modelID: recent.data.modelID,
          sourceFile: recent.file,
          source: 'recent-active-session',
          warning: '使用最近活跃session的模型配置，可能不是当前会话的准确配置',
          confidence: 'low'
        };
      }
    }
    
    return {
      success: false,
      error: `无法获取模型信息: Session目录不存在且没有找到相关消息`,
      suggestions: [
        '在OpenCode中发送一条消息以创建session目录',
        '设置 OPENCODE_MODEL 环境变量指定模型',
        '检查 ~/.local/share/opencode/storage/message/ 目录结构'
      ]
    };
  }

  /**
   * 获取认证信息
   */
  _getAuthInfo(providerID) {
    if (!fs.existsSync(this.authFile)) {
      return { apiKey: null, baseUrl: null };
    }
    
    try {
      const authData = JSON.parse(fs.readFileSync(this.authFile, 'utf8'));
      const config = authData[providerID];
      
      if (config) {
        return {
          apiKey: config.apiKey || config.key || config.token,
          baseUrl: config.baseUrl || config.endpoint
        };
      }
      
      // 尝试不区分大小写查找
      for (const [key, value] of Object.entries(authData)) {
        if (key.toLowerCase() === providerID.toLowerCase()) {
          return {
            apiKey: value.apiKey || value.key || value.token,
            baseUrl: value.baseUrl || value.endpoint
          };
        }
      }
      
    } catch (error) {
      this._log(`读取认证文件失败: ${error.message}`, 'debug');
    }
    
    return { apiKey: null, baseUrl: null };
  }

  /**
   * 获取默认Base URL
   */
  _getDefaultBaseUrl(providerID) {
    const defaultUrls = {
      openai: 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com',
      deepseek: 'https://api.deepseek.com',
      google: 'https://generativelanguage.googleapis.com',
      cohere: 'https://api.cohere.com',
      groq: 'https://api.groq.com/openai/v1',
      together: 'https://api.together.xyz/v1'
    };
    
    return defaultUrls[providerID] || null;
  }

  /**
   * 验证配置
   */
  _validateConfig(config) {
    const warnings = [];
    
    if (!config.apiKey) {
      warnings.push('缺少API key，无法进行API调用');
    }
    
    if (!config.baseUrl) {
      warnings.push('缺少Base URL，使用默认URL或需要手动设置');
    }
    
    if (config.confidence === 'low') {
      warnings.push('session检测置信度低，配置可能不准确');
    }
    
    return {
      valid: warnings.length === 0,
      warnings: warnings
    };
  }

  /**
   * 获取错误建议
   */
  _getErrorSuggestions(error) {
    const suggestions = [];
    const errorMsg = error.message || error.toString();
    
    if (errorMsg.includes('session')) {
      suggestions.push('运行 opencode session list 检查可用会话');
      suggestions.push('确认当前目录有OpenCode活动会话');
    }
    
    if (errorMsg.includes('auth') || errorMsg.includes('API')) {
      suggestions.push('检查 ~/.local/share/opencode/auth.json 文件');
      suggestions.push('运行 opencode auth list 查看认证配置');
    }
    
    if (errorMsg.includes('model')) {
      suggestions.push('在OpenCode中发送一条消息以创建模型记录');
      suggestions.push('检查 ~/.local/share/opencode/storage/message/ 目录');
    }
    
    suggestions.push('设置 OPENCODE_MODEL 环境变量指定模型');
    suggestions.push('查看完整文档: https://opencode.ai/docs/providers/');
    
    return suggestions;
  }

  // ==================== 辅助方法 ====================

  _getSessionsFromCLI() {
    try {
      if (this.options.debug) {
        this._log('尝试获取session列表...', 'debug');
      }
      
      const output = execSync('opencode session list --format json', { 
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'], // 捕获stderr
        timeout: 5000 // 5秒超时
      });
      
      try {
        const sessions = JSON.parse(output);
        if (this.options.debug) {
          this._log(`成功获取 ${sessions.length} 个session`, 'debug');
        }
        return sessions;
      } catch (parseError) {
        this._log(`解析session列表失败: ${parseError.message}`, 'debug');
        // 尝试处理非JSON输出
        if (output.trim().startsWith('[') || output.trim().startsWith('{')) {
          this._log(`原始输出: ${output.substring(0, 200)}...`, 'debug');
        }
        return [];
      }
    } catch (error) {
      const errorMsg = error.message || error.toString();
      this._log(`获取session列表失败: ${errorMsg}`, 'debug');
      
      // 提供更详细的错误信息
      if (errorMsg.includes('ENOENT')) {
        this._log('opencode命令未找到，请确保OpenCode已正确安装', 'debug');
      } else if (errorMsg.includes('timeout')) {
        this._log('获取session列表超时', 'debug');
      }
      
      return [];
    }
  }

  _getAllMessageFiles() {
    const allFiles = [];
    
    if (!fs.existsSync(this.storageBase)) {
      if (this.options.debug) {
        this._log(`存储基础目录不存在: ${this.storageBase}`, 'debug');
      }
      return allFiles;
    }
    
    try {
      let sessionDirs = [];
      try {
        sessionDirs = fs.readdirSync(this.storageBase).filter(dir => dir.startsWith('ses_'));
      } catch (error) {
        if (this.options.debug) {
          this._log(`读取session目录失败: ${error.message}`, 'debug');
        }
        return allFiles;
      }
      
      if (this.options.debug) {
        this._log(`找到 ${sessionDirs.length} 个session目录`, 'debug');
      }
      
      for (const sessionDir of sessionDirs) {
        const sessionPath = path.join(this.storageBase, sessionDir);
        try {
          // 检查是否是目录
          const stat = fs.statSync(sessionPath);
          if (!stat.isDirectory()) {
            continue;
          }
          
          let files = [];
          try {
            files = fs.readdirSync(sessionPath);
          } catch (error) {
            // 跳过无法读取的目录
            if (this.options.debug) {
              this._log(`无法读取session目录 ${sessionDir}: ${error.message}`, 'debug');
            }
            continue;
          }
          
          const messageFiles = files
            .filter(f => f.startsWith('msg_') && f.endsWith('.json'))
            .map(f => {
              const filePath = path.join(sessionPath, f);
              try {
                const mtime = fs.statSync(filePath).mtime;
                let data = {};
                
                try {
                  data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                } catch (e) {
                  if (this.options.debug) {
                    this._log(`无法解析消息文件 ${filePath}: ${e.message}`, 'debug');
                  }
                }
                
                return {
                  session: sessionDir,
                  file: f,
                  path: filePath,
                  mtime: mtime.getTime(),
                  data: data
                };
              } catch (error) {
                // 跳过无法读取的文件
                if (this.options.debug) {
                  this._log(`无法读取消息文件 ${filePath}: ${error.message}`, 'debug');
                }
                return null;
              }
            })
            .filter(f => f !== null);
          
          allFiles.push(...messageFiles);
          
        } catch (error) {
          // 跳过无法访问的目录
          if (this.options.debug) {
            this._log(`处理session目录 ${sessionDir} 失败: ${error.message}`, 'debug');
          }
        }
      }
      
      // 按修改时间排序（最新的在前）
      allFiles.sort((a, b) => b.mtime - a.mtime);
      
      if (this.options.debug) {
        this._log(`总共找到 ${allFiles.length} 个消息文件`, 'debug');
      }
      
    } catch (error) {
      this._log(`获取消息文件失败: ${error.message}`, 'debug');
    }
    
    return allFiles;
  }

  _log(message, level = 'info') {
    if (this.options.silent && level !== 'error') return;
    
    const prefix = {
      'debug': '[DEBUG]',
      'info': '',
      'warn': '[WARN]',
      'error': '[ERROR]'
    }[level] || '';
    
    if (level === 'debug' && !this.options.debug) return;
    
    if (prefix) {
      console.log(`${prefix} ${message}`);
    } else {
      console.log(message);
    }
  }

  // ==================== 工具方法 ====================

  /**
   * 生成环境变量导出命令
   */
  generateExportCommands(config) {
    if (!config.success) return [];
    
    const commands = [];
    const provider = config.providerID.toUpperCase();
    
    // API key
    if (config.apiKey) {
      commands.push(`export ${provider}_API_KEY="${config.apiKey}"`);
    }
    
    // Base URL
    if (config.baseUrl) {
      commands.push(`export ${provider}_BASE_URL="${config.baseUrl}"`);
    }
    
    // 模型信息
    commands.push(`export OPENCODE_MODEL="${config.providerID}/${config.modelID}"`);
    
    return commands;
  }

  /**
   * 生成配置摘要
   */
  generateSummary(config) {
    if (!config.success) {
      return `配置获取失败: ${config.error}`;
    }
    
    const lines = [
      `Provider: ${config.providerID}`,
      `Model: ${config.modelID}`,
      `API Key: ${config.apiKey || '未找到'}`,
      `Base URL: ${config.baseUrl || '默认'}`,
      `Session: ${config.sessionTitle}`,
      `Directory: ${config.directory}`,
      `Method: ${config.detectionMethod}`,
      `Confidence: ${config.confidence}`
    ];
    
    return lines.join('\n');
  }
}

// ==================== 模块导出 ====================

// 创建默认实例
const defaultDetector = new OpenCodeModelDetector();

// 导出类
module.exports = OpenCodeModelDetector;

// 导出默认实例的方法
module.exports.getCurrentModelConfig = () => defaultDetector.getCurrentModelConfig();
module.exports.getCurrentModelString = () => defaultDetector.getCurrentModelString();
module.exports.getCurrentApiKey = () => defaultDetector.getCurrentApiKey();
module.exports.validateForApiUse = () => defaultDetector.validateForApiUse();
module.exports.generateExportCommands = (config) => defaultDetector.generateExportCommands(config);
module.exports.generateSummary = (config) => defaultDetector.generateSummary(config);

// 导出创建新实例的方法
module.exports.createDetector = (options) => new OpenCodeModelDetector(options);

// ==================== CLI模式 ====================

if (require.main === module) {
  const args = process.argv.slice(2);
  const detector = new OpenCodeModelDetector({
    debug: args.includes('--debug'),
    silent: args.includes('--silent') || (!args.includes('--debug') && !args.includes('--help'))
  });
  
  if (args.includes('--simple') || args.includes('-s')) {
    // 简单输出
    const modelString = detector.getCurrentModelString();
    console.log(modelString);
    
  } else if (args.includes('--validate') || args.includes('-v')) {
    // 验证输出
    const validation = detector.validateForApiUse();
    console.log(validation.message);
    
  } else if (args.includes('--export') || args.includes('-e')) {
    // 导出环境变量
    const config = detector.getCurrentModelConfig();
    const commands = detector.generateExportCommands(config);
    commands.forEach(cmd => console.log(cmd));
    
  } else if (args.includes('--help') || args.includes('-h')) {
    // 帮助信息
    console.log(`
OpenCode Model Detector

Usage:
  node opencode-model-detector.js [options]

Options:
  -s, --simple     Simple output (provider/model)
  -v, --validate   Validate config for API use
  -e, --export     Export environment variables
  --debug          Show debug information
  --silent         Silent mode (no logs)
  -h, --help       Show this help

Examples:
  node opencode-model-detector.js              # Full output
  node opencode-model-detector.js --simple     # Model name only
  node opencode-model-detector.js --export     # Export env vars

Code usage:
  const detector = require('./opencode-model-detector.js');
  const config = detector.getCurrentModelConfig();
    `);
    
  } else {
    // 完整输出
    const config = detector.getCurrentModelConfig();
    const summary = detector.generateSummary(config);
    console.log(summary);
  }
}