#!/usr/bin/env python3
# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
parse_config.py - 解析 iter-config.yaml 并输出结构化信息

用法:
    # 输出完整配置摘要（给 agent 阅读）
    python3 parse_config.py /path/to/iter-config.yaml

    # 提取单个字段值（给脚本调用）
    python3 parse_config.py /path/to/iter-config.yaml --get skill.name
    python3 parse_config.py /path/to/iter-config.yaml --get optimization.goal
    python3 parse_config.py /path/to/iter-config.yaml --get tasks.query
    python3 parse_config.py /path/to/iter-config.yaml --get tasks.optimize
    python3 parse_config.py /path/to/iter-config.yaml --get tasks.sync
    python3 parse_config.py /path/to/iter-config.yaml --get optimization.max_rounds
    python3 parse_config.py /path/to/iter-config.yaml --get interactions
"""

import sys
import os
import json

try:
    import yaml
except ImportError:
    print("错误: 需要安装 pyyaml，请运行 pip install pyyaml", file=sys.stderr)
    sys.exit(2)


def load_config(config_path):
    if not os.path.exists(config_path):
        print(f"配置文件不存在: {config_path}", file=sys.stderr)
        sys.exit(1)
    with open(config_path, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)

DEFAULT_TASK_OPTIMIZE = "请使用 skill-optimizer 技能基于 ${skill_path} 这个 skill 的最近执行记录，动态优化这个 skill"
DEFAULT_TASK_SYNC = "请使用 skill-sync 技能将 ${skill_path} 上传到 insight 平台"


def get_nested(config, key_path):
    """按点号路径提取嵌套字段"""
    keys = key_path.split('.')
    val = config
    for k in keys:
        if isinstance(val, dict) and k in val:
            val = val[k]
        else:
            return None
    return val


def get_task(config, key):
    tasks = config.get('tasks', {}) or {}
    if key == 'query':
        val = tasks.get('query')
        if val is None:
            val = tasks.get('execute')
        return val
    if key == 'execute':
        val = tasks.get('execute')
        if val is None:
            val = tasks.get('query')
        return val
    if key == 'optimize':
        val = tasks.get('optimize')
        if val is None:
            val = DEFAULT_TASK_OPTIMIZE
        return val
    if key == 'sync':
        val = tasks.get('sync')
        if val is None:
            val = DEFAULT_TASK_SYNC
        return val
    return tasks.get(key)


def format_interactions(interactions):
    """将交互预设格式化为可读文本"""
    if not interactions:
        return "无"
    lines = []
    for i, item in enumerate(interactions, 1):
        lines.append(f"  场景 {i}: {item['scenario']}")
        lines.append(f"    触发条件: {item['trigger']}")
        resp = item['response'].strip()
        if '\n' in resp:
            lines.append(f"    回答:")
            for rline in resp.split('\n'):
                lines.append(f"      {rline}")
        else:
            lines.append(f"    回答: {resp}")
    return '\n'.join(lines)


def print_summary(config):
    """输出完整配置摘要"""
    skill = config.get('skill', {})
    optimization = config.get('optimization', {})
    interactions = config.get('interactions', [])

    # 变量替换
    skill_name = skill.get('name', '')
    skill_path = skill.get('path', '')
    task_query = (get_task(config, 'query') or '')
    task_optimize = (get_task(config, 'optimize') or '')
    task_sync = (get_task(config, 'sync') or '')

    print("=" * 60)
    print("迭代优化配置摘要")
    print("=" * 60)
    print(f"测试框架:       {config.get('framework', 'opencode')}")
    print(f"Skill 名称:     {skill_name}")
    print(f"Skill 路径:     {skill_path}")
    print(f"最大轮次:       {optimization.get('max_rounds', 5)}")
    print(f"达标阈值:       {optimization.get('score_threshold', '未设置')}")
    print(f"优化目标:       {optimization.get('goal', '').strip()}")
    print("-" * 60)
    print(f"测试任务:       {str(task_query).strip()}")
    print(f"优化任务:       {str(task_optimize).strip().replace('${skill_name}', skill_name).replace('${skill_path}', skill_path)}")
    print(f"同步任务:       {str(task_sync).strip().replace('${skill_name}', skill_name).replace('${skill_path}', skill_path)}")
    print("-" * 60)
    print(f"交互预设 ({len(interactions)} 条):")
    print(format_interactions(interactions))
    print("=" * 60)


def main():
    if len(sys.argv) < 2:
        print("用法: python3 parse_config.py <config.yaml> [--get <field>]", file=sys.stderr)
        sys.exit(1)

    config_path = sys.argv[1]
    config = load_config(config_path)

    # 提取单个字段
    if len(sys.argv) >= 4 and sys.argv[2] == '--get':
        field = sys.argv[3]

        # 特殊处理: interactions 输出为 JSON
        if field == 'interactions':
            interactions = config.get('interactions', [])
            print(json.dumps(interactions, ensure_ascii=False, indent=2))
            return

        # 特殊处理: 带变量替换的 tasks
        skill_name = config.get('skill', {}).get('name', '')
        skill_path = config.get('skill', {}).get('path', '')

        if field == 'tasks.query':
            val = get_task(config, 'query')
        elif field == 'tasks.execute':
            val = get_task(config, 'execute')
        elif field == 'tasks.optimize':
            val = get_task(config, 'optimize')
        elif field == 'tasks.sync':
            val = get_task(config, 'sync')
        else:
            val = get_nested(config, field)
        if val is None:
            print(f"字段不存在: {field}", file=sys.stderr)
            sys.exit(1)

        val = str(val).strip()
        val = val.replace('${skill_name}', skill_name)
        val = val.replace('${skill_path}', skill_path)
        print(val)
        return

    # 默认: 输出完整摘要
    print_summary(config)


if __name__ == "__main__":
    main()
