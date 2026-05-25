// @ts-nocheck
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const DEBUG_LOG = path.join(os.homedir(), '.opencode', 'witty_plugin_debug.log');

function logDebug(msg) {
    try {
        const logDir = path.dirname(DEBUG_LOG);
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + msg + '\n');
    } catch (e) {}
}

// Global store
let sessionStore = new Map();
let uploadedSessions = new Map(); // sessionId -> uploaded message count
let sessionGraph = new Map(); // parent_id -> [child_ids]
let pendingChildSessions = new Map(); // child_id -> {parent_id, data}
let lastDeltaByPartField = new Map();
let sessionParentById = new Map();
let sessionAgentById = new Map();
let subagentTypeBySessionId = new Map();
let eagerFlushMsgIds = new Set();
let lastEagerFlushAtBySessionId = new Map();

const STORE_PATH = path.join(os.homedir(), '.opencode', 'witty_plugin_session_store.json');

function cleanupOldSessions() {
    const now = Date.now();
    const threeDays = 3 * 24 * 3600 * 1000;
    
    let deletedCount = 0;
    for (const [msgId, entry] of sessionStore.entries()) {
        const time = entry.info?.created || entry.info?.time?.created;
        if (time && (now - time > threeDays)) {
            sessionStore.delete(msgId);
            deletedCount++;
        }
    }
    if (deletedCount > 0) logDebug(`Cleaned up ${deletedCount} old messages from sessionStore`);
}

function loadStore() {
    try {
        if (fs.existsSync(STORE_PATH)) {
            const fileData = fs.readFileSync(STORE_PATH, 'utf8');
            if (!fileData.trim()) return;
            const data = JSON.parse(fileData);
            
            // Merge sessionStore: disk entries fill in gaps, but don't overwrite in-memory entries
            if (data.sessionStore) {
                const diskStore = new Map(data.sessionStore);
                for (const [msgId, entry] of diskStore.entries()) {
                    if (!sessionStore.has(msgId)) {
                        if (entry.parts && !Array.isArray(entry.parts) && typeof entry.parts === 'object' && !(entry.parts instanceof Map)) {
                             entry.parts = new Map(Object.entries(entry.parts));
                        } else if (Array.isArray(entry.parts)) {
                             entry.parts = new Map(entry.parts);
                        } else if (!entry.parts) {
                             entry.parts = new Map();
                        }
                        
                        if (entry.toolParts && !Array.isArray(entry.toolParts) && typeof entry.toolParts === 'object' && !(entry.toolParts instanceof Map)) {
                             entry.toolParts = new Map(Object.entries(entry.toolParts));
                        } else if (Array.isArray(entry.toolParts)) {
                             entry.toolParts = new Map(entry.toolParts);
                        } else if (!entry.toolParts) {
                             entry.toolParts = new Map();
                        }

                        sessionStore.set(msgId, entry);
                    }
                }
            }
            
            // Merge uploadedSessions: keep the "newer" signature between memory and disk
            if (data.uploadedSessions) {
                for (const x of data.uploadedSessions) {
                    const sid = Array.isArray(x) ? x[0] : x;
                    const diskVal = Array.isArray(x) ? x[1] : 0;

                    const normalize = (v) => {
                        if (typeof v === 'number') return { count: v, lastAssistantLen: 0, lastTs: 0 };
                        if (v && typeof v === 'object') {
                            return {
                                count: Number(v.count || 0),
                                lastAssistantLen: Number(v.lastAssistantLen || 0),
                                lastTs: Number(v.lastTs || 0)
                            };
                        }
                        return { count: 0, lastAssistantLen: 0, lastTs: 0 };
                    };

                    const memSig = normalize(uploadedSessions.get(sid));
                    const diskSig = normalize(diskVal);

                    const diskNewer =
                        diskSig.count > memSig.count ||
                        (diskSig.count === memSig.count && diskSig.lastAssistantLen > memSig.lastAssistantLen) ||
                        (diskSig.count === memSig.count && diskSig.lastAssistantLen === memSig.lastAssistantLen && diskSig.lastTs > memSig.lastTs);

                    if (diskNewer) {
                        uploadedSessions.set(sid, diskVal);
                    } else if (!uploadedSessions.has(sid)) {
                        uploadedSessions.set(sid, memSig);
                    }
                }
            }
            
            // Merge sessionGraph: union child lists
            if (data.sessionGraph) {
                const diskGraph = new Map(data.sessionGraph);
                for (const [parentId, childIds] of diskGraph.entries()) {
                    if (!sessionGraph.has(parentId)) {
                        sessionGraph.set(parentId, childIds);
                    } else {
                        const existing = sessionGraph.get(parentId);
                        for (const cid of childIds) {
                            if (!existing.includes(cid)) existing.push(cid);
                        }
                    }
                }
            }
            
            // Merge pendingChildSessions
            if (data.pendingChildSessions) {
                const diskPending = new Map(data.pendingChildSessions);
                for (const [childId, childData] of diskPending.entries()) {
                    if (!pendingChildSessions.has(childId)) {
                        pendingChildSessions.set(childId, childData);
                    }
                }
            }

            if (data.sessionParentById) {
                const diskParents = new Map(data.sessionParentById);
                for (const [sid, pid] of diskParents.entries()) {
                    if (!sessionParentById.has(sid) && pid) sessionParentById.set(sid, pid);
                }
            }

            if (data.sessionAgentById) {
                const diskAgents = new Map(data.sessionAgentById);
                for (const [sid, agentName] of diskAgents.entries()) {
                    if (!sessionAgentById.has(sid) && agentName) sessionAgentById.set(sid, agentName);
                }
            }

            if (data.subagentTypeBySessionId) {
                const diskTypes = new Map(data.subagentTypeBySessionId);
                for (const [sid, t] of diskTypes.entries()) {
                    if (!subagentTypeBySessionId.has(sid) && t) subagentTypeBySessionId.set(sid, t);
                }
            }
            
            logDebug(`Loaded store (merged): ${sessionStore.size} messages`);
        }
    } catch(e) {
        logDebug("Store read err: " + e.message);
    }
}

function saveStore() {
    try {
        cleanupOldSessions();
        
        // Merge with disk state to prevent concurrent process data loss.
        // loadStore() uses merge semantics (won't overwrite in-memory entries).
        loadStore();
        
        const data = {
            sessionStore: Array.from(sessionStore.entries()).map(([k, v]) => [k, {
                ...v,
                parts: v.parts instanceof Map ? Array.from(v.parts.entries()) : (v.parts || []),
                toolParts: v.toolParts instanceof Map ? Array.from(v.toolParts.entries()) : (v.toolParts || [])
            }]),
            uploadedSessions: Array.from(uploadedSessions.entries()),
            sessionGraph: Array.from(sessionGraph.entries()),
            pendingChildSessions: Array.from(pendingChildSessions.entries()),
            sessionParentById: Array.from(sessionParentById.entries()),
            sessionAgentById: Array.from(sessionAgentById.entries()),
            subagentTypeBySessionId: Array.from(subagentTypeBySessionId.entries()),
            timestamp: new Date().toISOString()
        };
        fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch(e) {
        logDebug("Store sync err: " + e.message);
    }
}

function toMsTimestamp(v) {
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const s = v.trim();
        if (!s) return null;
        // numeric string (ms)
        if (/^\d+$/.test(s)) {
            const n = Number(s);
            return Number.isFinite(n) ? n : null;
        }
        // ISO-like
        const t = Date.parse(s);
        return Number.isFinite(t) ? t : null;
    }
    return null;
}

function buildTiming(startRaw, endRaw) {
    const startMs = toMsTimestamp(startRaw);
    const endMs = toMsTimestamp(endRaw);
    let durationMs = null;
    if (startMs != null && endMs != null) {
        const d = endMs - startMs;
        // guard against bogus clocks/units: ignore >= 1h spans for tool call
        if (d >= 0 && d < 3600000) durationMs = d;
    }
    // Only attach timing if we have at least one bound
    if (startRaw == null && endRaw == null) return undefined;
    const timing = {};
    if (startRaw != null) timing.started_at = startRaw;
    if (endRaw != null) timing.completed_at = endRaw;
    if (durationMs != null) timing.duration_ms = durationMs;
    return timing;
}

// Helper: Check if host should skip proxy based on NO_PROXY
function shouldSkipProxy(targetHostname) {
    const noProxy = process.env.no_proxy || process.env.NO_PROXY;
    if (!noProxy) return false;
    const segments = noProxy.split(',').map(s => s.trim().toLowerCase());
    return segments.some(s => s === '*' || targetHostname.toLowerCase().endsWith(s));
}

// Helper: Get proxy setup
function getRequestOptions(targetUrl, apiKey, bodyLength) {
    const protocol = targetUrl.protocol;
    const proxy = (protocol === 'https:' ? (process.env.https_proxy || process.env.HTTPS_PROXY) : (process.env.http_proxy || process.env.HTTP_PROXY)) || process.env.all_proxy || process.env.ALL_PROXY;
    
    let options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (protocol === 'https:' ? 443 : 80),
        path: (targetUrl.pathname === '/' ? '' : targetUrl.pathname) + '/api/upload',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': bodyLength,
            'x-witty-api-key': apiKey
        }
    };

    if (proxy && !shouldSkipProxy(targetUrl.hostname)) {
        try {
            const proxyUrl = new URL(proxy);
            if (protocol === 'http:') {
                options.hostname = proxyUrl.hostname;
                options.port = proxyUrl.port || 80;
                options.path = targetUrl.origin + options.path;
                if (proxyUrl.username) {
                    const auth = Buffer.from(`${proxyUrl.username}:${proxyUrl.password}`).toString('base64');
                    options.headers['Proxy-Authorization'] = `Basic ${auth}`;
                }
            }
        } catch (e) {}
    }
    return options;
}

function loadConfiguration() {
    let config = {};
    try {
        const envPath = path.join(os.homedir(), '.skill-insight', '.env');
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf8');
            content.split('\n').forEach(line => {
                const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)?\s*$/);
                if (match) config[match[1]] = (match[2] || '').trim().replace(/^['"](.*)['"]$/, '$1');
            });
        }
    } catch (e) {}
    return {
        apiKey: config['SKILL_INSIGHT_API_KEY'] || process.env.SKILL_INSIGHT_API_KEY,
        host: config['SKILL_INSIGHT_HOST'] || process.env.SKILL_INSIGHT_HOST
    };
}

function collectSessionMessages(sessionId) {
    const messages = [];
    logDebug(`collectSessionMessages: scanning ${sessionStore.size} entries for session ${sessionId}`);
    for (const [mid, entry] of sessionStore.entries()) {
        if (entry.info.sessionID === sessionId) {
            // Calculate latency for this message if possible from parts
            let partBasedDuration = 0;
            if (entry.parts instanceof Map && entry.parts.size > 0) {
                const parts = Array.from(entry.parts.values()).map(p => p.time?.start || 0).filter(t => t > 0).sort((a,b)=>a-b);
                if (parts.length >= 1) {
                    const start = parts[0];
                    const end = parts[parts.length - 1];
                    partBasedDuration = Math.max(0, end - start);
                }
            }

            const role = entry.info.role || 'unknown';
            const content = entry.content || entry.info.content || "";
            logDebug(`Found message in store: id=${mid}, role=${role}, content_len=${content.length}`);

            messages.push({
                role: role,
                content: content,
                tool_calls: entry.info.tool_calls || entry.info.toolCalls,
                function_call: entry.info.function_call || entry.info.functionCall,
                usage: entry.info.usage || entry.info.tokens,
                timestamp: entry.info.created || entry.info.time?.created,
                timeInfo: entry.info.time,
                partBasedDuration: partBasedDuration,
                modelID: entry.info.modelID,
                model: entry.info.model,
                agent: entry.info.agent
            });
        }
    }
    logDebug(`collectSessionMessages: collected ${messages.length} messages for ${sessionId}`);
    return messages;
}

function cleanupOrphanedSessions() {
    const now = Date.now();
    const oneHourMs = 3600000;
    
    for (const [childId, childData] of pendingChildSessions.entries()) {
        try {
            const childTime = new Date(childData.timestamp).getTime();
            if (now - childTime > oneHourMs) {
                logDebug(`Cleaning up orphaned child session ${childId}`);
                pendingChildSessions.delete(childId);
            }
        } catch (e) {
            logDebug(`Error checking child session ${childId}: ${e.message}`);
        }
    }
}

function findRootSessionId(sessionId) {
    let cur = sessionId;
    const visited = new Set();
    while (cur && cur.startsWith('ses') && !visited.has(cur)) {
        visited.add(cur);
        const p = sessionParentById.get(cur);
        if (!p || !p.startsWith('ses')) break;
        cur = p;
    }
    return cur;
}

function collectSessionWithDescendants(rootSessionId) {
    const messages = collectSessionMessages(rootSessionId);
    const mergedSessionIds = [];
    const visited = new Set();
    const stack = Array.isArray(sessionGraph.get(rootSessionId)) ? [...sessionGraph.get(rootSessionId)] : [];

    while (stack.length > 0) {
        const sid = stack.pop();
        if (!sid || visited.has(sid)) continue;
        visited.add(sid);

        const childData = pendingChildSessions.get(sid);
        if (childData && childData.messages) {
            logDebug(`Merging ${childData.messages.length} messages from child ${sid}`);
            const name =
                sessionAgentById.get(sid) ||
                subagentTypeBySessionId.get(sid) ||
                null;
            const subagentMessages = childData.messages.map(msg => {
                if (msg.role === 'assistant') {
                    return { ...msg, role: 'subagent', subagent_name: name || msg.agent, subagent_session_id: sid };
                } else if (msg.role === 'user') {
                    return { ...msg, role: 'opencode' };
                }
                return msg;
            });
            messages.push(...subagentMessages);
            mergedSessionIds.push(sid);
        }

        const next = sessionGraph.get(sid) || [];
        for (const x of next) stack.push(x);
    }

    return { messages, mergedSessionIds };
}

export default async function WittySkillInsightPlugin(input) {
  loadStore();
  const { apiKey, host } = loadConfiguration();
  if (!apiKey || !host) {
      logDebug("Plugin disabled: Missing API Key or Host");
      return {};
  }

  let parsedHost;
  try {
      const urlStr = host.match(/^https?:\/\//) ? host : `http://${host}`;
      parsedHost = new URL(urlStr);
  } catch (e) { return {}; }

  const requestModule = parsedHost.protocol === 'https:' ? https : http;

  // Auto-Sync Skills on Startup
  try {
     const syncScript = path.join(os.homedir(), '.skill-insight', 'sync_skills.ts');
     if (fs.existsSync(syncScript)) {
         const cp = require('child_process');
         // Run async to avoid blocking
         const cmd = `npx -y tsx "${syncScript}" --agent opencode`;
         
         // Only run if we are in a project directory that might use local skills?
         // Or always run. Always run is safer for "latest active" requirement.
         
         // Use exec to run in background
         cp.exec(cmd, { cwd: process.cwd() }, (err, stdout, stderr) => {
             if (err) logDebug(`Skill Sync Error: ${err.message}`);
             else if (stdout) logDebug(`Skill Sync: ${stdout.trim()}`);
         });
     }
  } catch (e) {
      logDebug(`Skill Sync Init Exception: ${e.message}`);
  }

  // logDebug("Witty Plugin Initialized");

  return {
    event: async ({ event }) => {
      logDebug(`Event received: ${event.type}`);
      if (event.type && event.type.startsWith('tool')) {
          logDebug(`Tool Payload: ${JSON.stringify(event.payload || event.properties || {})}`);
      }

      try {
          const rawLogPath = path.join(os.homedir(), '.opencode', 'witty_plugin_raw_events.log');
          if (!fs.existsSync(path.dirname(rawLogPath))) fs.mkdirSync(path.dirname(rawLogPath), { recursive: true });
          fs.appendFileSync(rawLogPath, JSON.stringify({t: new Date().toISOString(), ...event}) + '\n');
      } catch (e) {
          logDebug(`Raw Log Error: ${e.message}`);
      }

      // logDebug(`Event: ${event.type}`);

      try {
           // Attempt to find session ID in various places
           let sessionId = event.session_id || event.properties?.sessionID || event.payload?.session_id;
           let eagerFlush = false;

           if (event.type === 'session.created' || event.type === 'session.updated') {
               const sessionInfo = event.properties?.info || event.payload?.info;
               if (sessionInfo && sessionInfo.id) {
                   const sid = sessionInfo.id;
                   const pid = sessionInfo.parentID || sessionInfo.parentId || sessionInfo.parent_id;
                   if (pid && pid.startsWith('ses')) {
                       sessionParentById.set(sid, pid);
                       if (!sessionGraph.has(pid)) sessionGraph.set(pid, []);
                       if (!sessionGraph.get(pid).includes(sid)) {
                           sessionGraph.get(pid).push(sid);
                           logDebug(`Session created: ${sid} is child of ${pid}`);
                       }
                   }
               }
           }

           // 1. Accumulate Message Metadata
           if (event.type === 'message.created' || event.type === 'message.updated') {
             let info = (event.payload && event.payload.message) || (event.properties && event.properties.info);
             if (info && info.id) {
                 const msgId = info.id;
                 if (!sessionStore.has(msgId)) {
                     sessionStore.set(msgId, { 
                         info: { sessionID: sessionId }, 
                         parts: new Map(), 
                         content: '' 
                     });
                 }
                 const entry = sessionStore.get(msgId);
                 if (!sessionId) sessionId = info.sessionID || info.sessionId || entry.info?.sessionID;
                 if (sessionId) entry.info.sessionID = sessionId;
                  // Merge info
                  Object.assign(entry.info, info);
                  if (info.tool_calls || info.toolCalls) entry.info.tool_calls = info.tool_calls || info.toolCalls;
                  if (info.function_call || info.functionCall) entry.info.function_call = info.function_call || info.functionCall;

                 if (entry.info?.sessionID && entry.info?.agent) {
                     if (!sessionAgentById.has(entry.info.sessionID)) {
                         sessionAgentById.set(entry.info.sessionID, entry.info.agent);
                     }
                 }

                 if (entry.info?.role === 'assistant' && (entry.info.finish || entry.info.time?.completed != null)) {
                     if (!eagerFlushMsgIds.has(msgId)) {
                         eagerFlushMsgIds.add(msgId);
                         if (eagerFlushMsgIds.size > 5000) {
                             eagerFlushMsgIds = new Set(Array.from(eagerFlushMsgIds).slice(-4000));
                         }
                         eagerFlush = true;
                     }
                 }
             }
          }

          // 2. Accumulate Message Content Parts
          if (event.type === 'message.part.created' || event.type === 'message.part.updated') {
              let part = (event.payload && event.payload.part) || (event.properties && event.properties.part);
              if (!part && event.payload) part = event.payload; // fallback

              if (part && (part.messageID || part.message_id)) {
                  const msgId = part.messageID || part.message_id;
                  
                  if (!sessionStore.has(msgId)) {
                        sessionStore.set(msgId, { 
                             info: { sessionID: sessionId }, 
                             parts: new Map(), 
                             toolParts: new Map(),
                             content: '' 
                        });
                  }
                  const entry = sessionStore.get(msgId);
                  if (!sessionId) sessionId = entry.info?.sessionID || part.sessionID || part.session_id;
                  if (!(entry.parts instanceof Map)) entry.parts = new Map(Array.isArray(entry.parts) ? entry.parts : []);
                  if (entry.toolParts && !(entry.toolParts instanceof Map)) entry.toolParts = new Map(Array.isArray(entry.toolParts) ? entry.toolParts : []);
                  
                  // Store part
                  const partId = part.id || `temp_${Date.now()}_${Math.random()}`;
                  
                  if (part.type === 'tool') {
                      // Tool calls in OpenCode are often special parts
                      if (!entry.toolParts) entry.toolParts = new Map();
                      entry.toolParts.set(part.callID || partId, part);
                  } else {
                      entry.parts.set(partId, part);
                  }
                  
                  // Reassemble content (text)
                  let full = "";
                  const sortedParts = Array.from(entry.parts.values()).sort((a, b) => {
                      const ta = a.time?.start || (a.meta && a.meta.start) || 0;
                      const tb = b.time?.start || (b.meta && b.meta.start) || 0;
                      return ta - tb;
                  });
                  
                  for (const p of sortedParts) {
                      if (p.text) full += p.text;
                      else if (p.content) full += p.content;
                  }
                  entry.content = full;

                   // Process Tool Calls for storage
                   if (entry.toolParts && entry.toolParts.size > 0) {
                       const tool_calls = [];
                       for (const tp of entry.toolParts.values()) {
                           if (tp.tool && tp.state) {
                               // Try to infer timing from common OpenCode shapes
                               const startRaw =
                                   tp.time?.start ??
                                   tp.time?.created ??
                                   tp.meta?.start ??
                                   tp.meta?.created ??
                                   tp.state?.time?.start ??
                                   tp.state?.time?.created ??
                                   tp.state?.started_at ??
                                   tp.state?.startTime ??
                                   tp.state?.start_time ??
                                   null;
                               const endRaw =
                                   tp.time?.completed ??
                                   tp.time?.end ??
                                   tp.meta?.completed ??
                                   tp.meta?.end ??
                                   tp.state?.time?.completed ??
                                   tp.state?.time?.end ??
                                   tp.state?.completed_at ??
                                   tp.state?.endTime ??
                                   tp.state?.end_time ??
                                   null;
                               const timing = buildTiming(startRaw, endRaw);

                               tool_calls.push({
                                   id: tp.callID,
                                   type: 'function',
                                   function: {
                                       name: tp.tool,
                                       arguments: JSON.stringify(tp.state.input || {})
                                   },
                                   state: tp.state.status,
                                   output: tp.state.output,
                                   timing: timing
                               });

                               // Detect task tool calls and extract subagent session_id
                               if (tp.tool === 'task' && tp.state.output) {
                                   try {
                                       const taskOutput = tp.state.output;
                                       let subagentSessionId = null;
                                       const m1 = taskOutput.match(/<task_metadata>[\s\S]*?session_id:\s*(ses_[A-Za-z0-9]+)[\s\S]*?<\/task_metadata>/i);
                                       const m2 = taskOutput.match(/session_id:\s*(ses_[A-Za-z0-9]+)/i);
                                       const m3 = taskOutput.match(/task\(\s*session_id\s*=\s*\"(ses_[A-Za-z0-9]+)\"/i);
                                       const m4 = taskOutput.match(/task_id:\s*(\w+)/i);
                                       const candidate = (m1 && m1[1]) || (m2 && m2[1]) || (m3 && m3[1]) || (m4 && m4[1]) || null;
                                       if (candidate && String(candidate).startsWith('ses')) subagentSessionId = String(candidate);

                                       if (subagentSessionId) {
                                           const parentSessionId = entry.info.sessionID || sessionId;
                                           if (parentSessionId) {
                                               if (!sessionGraph.has(parentSessionId)) sessionGraph.set(parentSessionId, []);
                                               if (!sessionGraph.get(parentSessionId).includes(subagentSessionId)) {
                                                   sessionGraph.get(parentSessionId).push(subagentSessionId);
                                                   logDebug(`Task detected: ${subagentSessionId} is child of ${parentSessionId}`);
                                               }
                                               if (!sessionParentById.has(subagentSessionId)) {
                                                   sessionParentById.set(subagentSessionId, parentSessionId);
                                               }
                                           }

                                           const t = tp.state?.input?.subagent_type;
                                           if (t && !subagentTypeBySessionId.has(subagentSessionId)) {
                                               subagentTypeBySessionId.set(subagentSessionId, t);
                                           }
                                       }
                                   } catch (e) {
                                       logDebug(`Error parsing task output: ${e.message}`);
                                   }
                               }
                           }
                       }
                       if (tool_calls.length > 0) {
                            entry.info.tool_calls = tool_calls;
                       }
                   }
                  
                  // Update SessionID if found in event
                  if (sessionId && !entry.info.sessionID) entry.info.sessionID = sessionId;
              }
          }

          if (event.type === 'message.part.delta') {
              const props = event.properties || event.payload || {};
              const msgId = props.messageID || props.message_id;
              const partId = props.partID || props.part_id;
              const field = props.field;
              const delta = props.delta;

              if (msgId && partId && field && typeof delta === 'string') {
                  if (!sessionStore.has(msgId)) {
                      sessionStore.set(msgId, {
                          info: { sessionID: sessionId },
                          parts: new Map(),
                          toolParts: new Map(),
                          content: ''
                      });
                  }

                  const entry = sessionStore.get(msgId);
                  if (!sessionId) sessionId = entry.info?.sessionID;
                  if (!(entry.parts instanceof Map)) entry.parts = new Map(Array.isArray(entry.parts) ? entry.parts : []);

                  const dedupeKey = `${msgId}:${partId}:${field}`;
                  const lastDelta = lastDeltaByPartField.get(dedupeKey);
                  if (lastDelta !== delta) {
                      lastDeltaByPartField.set(dedupeKey, delta);
                      if (lastDeltaByPartField.size > 5000) {
                          for (const k of lastDeltaByPartField.keys()) {
                              lastDeltaByPartField.delete(k);
                              if (lastDeltaByPartField.size <= 4000) break;
                          }
                      }

                      const existingPart = entry.parts.get(partId) || {
                          id: partId,
                          messageID: msgId,
                          sessionID: sessionId,
                          type: 'text'
                      };
                      const prev = typeof existingPart[field] === 'string' ? existingPart[field] : '';
                      existingPart[field] = prev + delta;
                      entry.parts.set(partId, existingPart);

                      let full = "";
                      const sortedParts = Array.from(entry.parts.values()).sort((a, b) => {
                          const ta = a.time?.start || (a.meta && a.meta.start) || 0;
                          const tb = b.time?.start || (b.meta && b.meta.start) || 0;
                          return ta - tb;
                      });

                      for (const p of sortedParts) {
                          if (p.text) full += p.text;
                          else if (p.content) full += p.content;
                      }
                      entry.content = full;
                  }
              }
          }

           // 3. Upload on Session Idle
           if (event.type === "session.idle" || eagerFlush) {
               if (!sessionId || !sessionId.startsWith("ses")) return;

               const isIdleTrigger = event.type === "session.idle";
               if (!isIdleTrigger) {
                   const THROTTLE_MS = Number(process.env.WITTY_EAGER_FLUSH_THROTTLE_MS || 2000);
                   const throttleMs = Number.isFinite(THROTTLE_MS) && THROTTLE_MS > 0 ? THROTTLE_MS : 0;
                   if (throttleMs > 0) {
                       const now = Date.now();
                       const last = lastEagerFlushAtBySessionId.get(sessionId) || 0;
                       if (now - last < throttleMs) {
                           logDebug(`Skipping eagerFlush upload for ${sessionId}: throttled (${now - last}ms < ${throttleMs}ms)`);
                           return;
                       }
                       lastEagerFlushAtBySessionId.set(sessionId, now);
                   }
               }

               // Reload store from disk to pick up any data written by
               // concurrent child processes (e.g. opencode run executed
               // from within the opencode interactive interface).
               loadStore();

               let foundParentId = null;
               const directParent = sessionParentById.get(sessionId);
               if (directParent && Array.isArray(sessionGraph.get(directParent)) && sessionGraph.get(directParent).includes(sessionId)) {
                   foundParentId = directParent;
                   logDebug(`Found parent ${foundParentId} for for child ${sessionId} from sessionParentById`);
               } else {
                   for (const [potentialParent, childIds] of sessionGraph.entries()) {
                       if (childIds.includes(sessionId)) {
                           foundParentId = potentialParent;
                           logDebug(`Found parent ${foundParentId} for for child ${sessionId} from sessionGraph`);
                           break;
                       }
                   }
               }
               
               if (foundParentId) {
                   logDebug(`Child ${sessionId} detected with parent ${foundParentId}`);
                   
                   // Store child session data and wait for parent
                   if (!sessionGraph.has(foundParentId)) {
                       sessionGraph.set(foundParentId, []);
                   }
                   if (!sessionGraph.get(foundParentId).includes(sessionId)) {
                       sessionGraph.get(foundParentId).push(sessionId);
                   }
                   
                   // Collect and store child session data
                   const childMessages = collectSessionMessages(sessionId);
                   if (childMessages.length > 0) {
                       pendingChildSessions.set(sessionId, {
                           parent_id: foundParentId,
                           messages: childMessages,
                           timestamp: new Date().toISOString()
                       });
                       logDebug(`Stored ${childMessages.length} messages for child session ${sessionId}`);
                   }

                   const rootId = findRootSessionId(foundParentId) || foundParentId;
                   if (!rootId || rootId === sessionId) return;
                   sessionId = rootId;
               }

               logDebug(`Session Idle: ${sessionId}. Messages in store: ${sessionStore.size}`);

               // This is a parent session, collect all messages including children
               const { messages, mergedSessionIds } = collectSessionWithDescendants(sessionId);

               if (messages.length === 0) {
                   logDebug(`No messages found for session ${sessionId}, skipping upload.`);
                   return;
               }

               // Cleanup child session data after successful upload
               for (const childId of mergedSessionIds) {
                   pendingChildSessions.delete(childId);
                   logDebug(`Cleaned up child session ${childId}`);
               }
               
               // Cleanup orphaned child sessions (older than 1 hour)
               cleanupOrphanedSessions();

              // Sort messages by timestamp safely
              messages.sort((a, b) => {
                  const ta = Number(a.timestamp) || 0;
                  const tb = Number(b.timestamp) || 0;
                  return ta - tb;
              });

              // Analyze
              let totalTokens = 0;
              let totalLatencyMs = 0;
              let firstUserQuery = "";
              let lastAssistantContent = "";
              let model = "";
              let totalInputTokens = 0;
              let totalOutputTokens = 0;
              let totalCacheReadInputTokens = 0;
              let totalCacheCreationInputTokens = 0;
              let totalReasoningTokens = 0;
              let llmCallCount = 0;
              let toolCallCount = 0;
              let toolCallErrorCount = 0;
              let maxSingleCallTokens = 0;

              let firstTs = Number.MAX_SAFE_INTEGER;
              let lastTs = 0;

              for (const m of messages) {
                  if (m.role === 'user' && !firstUserQuery) firstUserQuery = m.content;
                  const isCompletion = m.role === 'assistant' || m.role === 'subagent';
                  if (m.role === 'assistant') {
                      lastAssistantContent = m.content;
                      if (m.model) model = m.model;
                      else if (m.modelID) model = m.modelID;
                  }

                  const t1 = toMsTimestamp(m.timestamp) || 0;
                  const t2 = toMsTimestamp(m.timeInfo?.completed) || 0;
                  const t3 = toMsTimestamp(m.timeInfo?.created) || 0;
                  
                  if (t1 > 0) {
                      firstTs = Math.min(firstTs, t1);
                      lastTs = Math.max(lastTs, t1);
                  }
                  if (t2 > 0) {
                      lastTs = Math.max(lastTs, t2);
                  }
                  if (t3 > 0) {
                      firstTs = Math.min(firstTs, t3);
                      lastTs = Math.max(lastTs, t3);
                  }

                  if (isCompletion) {
                      llmCallCount++;
                      
                      // Token logic
                      const u = m.usage;
                      if (u) {
                          if (u.total !== undefined) {
                              totalTokens += Number(u.total);
                          } else {
                              totalTokens += Number(u.input_tokens || u.input || 0) + Number(u.output_tokens || u.output || 0);
                              if (u.cache) {
                                  totalTokens += Number(u.cache.read || 0) + Number(u.cache.write || 0);
                              }
                              totalTokens += Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0);
                          }
                          // Extended metrics: separate input/output token counts
                          const cacheReadToks = Number(u.cache?.read || u.cache_read_input_tokens || 0);
                          const cacheCreateToks = Number(u.cache?.write || u.cache_creation_input_tokens || 0);
                          const inputToks = Number(u.input_tokens || u.input || 0);  // base input only (excludes cache)
                          const rawOutputToks = Number(u.output_tokens || u.output || 0);
                          const reasoningToks = Number(u.reasoning || u.reasoning_tokens || u.completion_tokens_details?.reasoning_tokens || 0);
                          // OpenCode reports reasoning separately from output; DeepSeek API includes it in output.
                          // Normalize: output_tokens should always include reasoning tokens.
                          const outputToks = (u.reasoning !== undefined && reasoningToks > 0 && rawOutputToks < reasoningToks)
                              ? rawOutputToks + reasoningToks
                              : rawOutputToks;
                          totalInputTokens += inputToks;
                          totalOutputTokens += outputToks;
                          totalCacheReadInputTokens += cacheReadToks;
                          totalCacheCreationInputTokens += cacheCreateToks;
                          totalReasoningTokens += reasoningToks;
                          const callTotal = inputToks + cacheReadToks + cacheCreateToks + outputToks;
                          if (callTotal > maxSingleCallTokens) maxSingleCallTokens = callTotal;
                      }

                      // Count tool calls from this message
                      if (m.tool_calls && Array.isArray(m.tool_calls)) {
                          toolCallCount += m.tool_calls.length;
                          for (const tc of m.tool_calls) {
                              if (tc.state === 'error' || tc.state === 'failed') {
                                  toolCallErrorCount++;
                              }
                          }
                      }
                  }
              }

              if (firstTs !== Number.MAX_SAFE_INTEGER && lastTs > firstTs) {
                  totalLatencyMs = lastTs - firstTs;
              }

              logDebug(`Uploading session ${sessionId}. Latency: ${totalLatencyMs}ms, Messages: ${messages.length}`);

              const payload = {
                  task_id: sessionId,
                  query: firstUserQuery || `OpenCode Session ${sessionId}`,
                  framework: 'opencode', 
                  model: model,
                  tokens: totalTokens,
                  latency: totalLatencyMs / 1000,
                  input_tokens: totalInputTokens,
                  output_tokens: totalOutputTokens,
                  tool_call_count: toolCallCount,
                  tool_call_error_count: toolCallErrorCount,
                  llm_call_count: llmCallCount,
                  cache_read_input_tokens: totalCacheReadInputTokens,
                  cache_creation_input_tokens: totalCacheCreationInputTokens,
                  max_single_call_tokens: maxSingleCallTokens,
                  reasoning_tokens: totalReasoningTokens,
                  final_result: lastAssistantContent,
                  interactions: messages.map(m => ({
                      role: m.role,
                      content: m.content,
                      tool_calls: m.tool_calls || m.toolCalls,
                      function_call: m.function_call || m.functionCall,
                      usage: m.usage,
                      timestamp: m.timestamp,
                      timeInfo: m.timeInfo,
                      agent: m.agent,
                      subagent_name: m.subagent_name,
                      subagent_session_id: m.subagent_session_id
                  })),
                  timestamp: new Date().toISOString()
              };

              let lastTs = 0;
              for (const m of messages) {
                  const t1 = toMsTimestamp(m.timestamp) || 0;
                  const t2 = toMsTimestamp(m.timeInfo?.completed) || 0;
                  const t3 = toMsTimestamp(m.timeInfo?.created) || 0;
                  lastTs = Math.max(lastTs, t1, t2, t3);
              }
              const lastAssistantLen = (lastAssistantContent || '').length;

              const normalize = (v) => {
                  if (typeof v === 'number') return { count: v, lastAssistantLen: 0, lastTs: 0 };
                  if (v && typeof v === 'object') {
                      return {
                          count: Number(v.count || 0),
                          lastAssistantLen: Number(v.lastAssistantLen || 0),
                          lastTs: Number(v.lastTs || 0)
                      };
                  }
                  return { count: 0, lastAssistantLen: 0, lastTs: 0 };
              };

              const prevSig = normalize(uploadedSessions.get(sessionId));
              const shouldSkip =
                  messages.length <= prevSig.count &&
                  lastAssistantLen <= prevSig.lastAssistantLen &&
                  lastTs <= prevSig.lastTs;

              if (shouldSkip) {
                  logDebug(`Session ${sessionId} already uploaded (count=${prevSig.count}, lastAssistantLen=${prevSig.lastAssistantLen}, lastTs=${prevSig.lastTs}) (cur: count=${messages.length}, lastAssistantLen=${lastAssistantLen}, lastTs=${lastTs}), skipping.`);
                  return;
              }
              uploadedSessions.set(sessionId, { count: messages.length, lastAssistantLen, lastTs });

              const body = JSON.stringify(payload);
              logDebug(`Payload Body Size: ${Buffer.byteLength(body)} bytes`);
              
              const options = getRequestOptions(parsedHost, apiKey, Buffer.byteLength(body));
              const isHttps = parsedHost.protocol === 'https:';

              const cp = require('child_process');
              const reqId = Date.now() + '_' + Math.floor(Math.random() * 10000);
              const tmpDir = os.tmpdir();
              const payloadPath = path.join(tmpDir, `witty_req_${reqId}.json`);
              const scriptPath = path.join(tmpDir, `witty_upload_${reqId}.js`);
              const logPath = path.join(tmpDir, `witty_upload_${reqId}.log`);

              const uploaderScript = `
const http = require('http');
const https = require('https');
const fs = require('fs');

try {
    const reqModule = ${isHttps ? 'https' : 'http'};
    const options = ${JSON.stringify(options)};
    const payloadPath = ${JSON.stringify(payloadPath)};
    const scriptPath = ${JSON.stringify(scriptPath)};
    const logPath = ${JSON.stringify(logPath)};
    const body = fs.readFileSync(payloadPath);
    options.headers['Content-Length'] = body.length;

    const req = reqModule.request(options, (res) => {
        let resBody = '';
        res.on('data', (chunk) => { resBody += chunk; });
        res.on('end', () => {
            try { fs.appendFileSync(logPath, new Date().toISOString() + ' Upload OK status=' + res.statusCode + ' body=' + resBody + '\\n'); } catch(e){}
            try { fs.unlinkSync(payloadPath); } catch(e){}
            try { fs.unlinkSync(scriptPath); } catch(e){}
        });
    });
    
    req.on('error', (err) => {
        try { fs.appendFileSync(logPath, new Date().toISOString() + ' Upload ERROR: ' + err.message + '\\n'); } catch(e){}
        try { fs.unlinkSync(payloadPath); } catch(e){}
        try { fs.unlinkSync(scriptPath); } catch(e){}
    });
    
    req.setTimeout(15000, () => {
        req.destroy();
        try { fs.appendFileSync(logPath, new Date().toISOString() + ' Upload TIMEOUT\\n'); } catch(e){}
        try { fs.unlinkSync(payloadPath); } catch(e){}
        try { fs.unlinkSync(scriptPath); } catch(e){}
    });
    
    req.end(body);
} catch (e) {
    try { fs.appendFileSync(${JSON.stringify(path.join(os.tmpdir(), 'witty_upload_crash.log'))}, new Date().toISOString() + ' CRASH: ' + e.message + '\\n'); } catch(x){}
    process.exit(1);
}
`;

              fs.writeFileSync(payloadPath, body);
              fs.writeFileSync(scriptPath, uploaderScript);

              // process.execPath in OpenCode's plugin runtime points to the
              // OpenCode binary itself (e.g. ~/.opencode/bin/opencode), NOT node.
              // We must explicitly resolve the node binary path.
              let nodeBin = 'node';
              try {
                  const nodeCmd = process.platform === 'win32' ? 'where node' : 'which node';
                  nodeBin = cp.execSync(nodeCmd, { encoding: 'utf8', timeout: 3000 }).trim() || 'node';
                  if (process.platform === 'win32') {
                      const lines = nodeBin.split('\n');
                      nodeBin = lines[0].trim() || 'node';
                  }
              } catch (e) {
                  logDebug(`Could not resolve node path, falling back to 'node'`);
              }
              
              logDebug(`Launching uploader: node=${nodeBin}, script=${scriptPath}`);
              try {
                  const uploader = cp.spawn(nodeBin, [scriptPath], {
                      detached: true,
                      stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
                      windowsHide: true
                  });
                  uploader.unref();
                  logDebug(`Uploader spawned successfully (PID: ${uploader.pid})`);
              } catch (spawnErr) {
                  logDebug(`spawn uploader error: ${spawnErr.message}`);
              }

              /* 
              // Cleanup - DISABLED
              // We want to accumulate history.
              for (const [msgId, entry] of sessionStore.entries()) {
                  if (entry.info.sessionID === sessionId) sessionStore.delete(msgId);
              }
              */
          }
      } catch (err) {
          logDebug(`Plugin Exception: ${err.message}`);
      } finally {
        saveStore();
      }
    }
  };
}
