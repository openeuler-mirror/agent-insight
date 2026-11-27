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
OTEL Receiver v3 - 使用 Flask-like 的 WSGI 方式处理 chunked body

Claude Code 的 OTEL SDK 发送的请求没有 Content-Length（chunked transfer encoding），
Python http.server 无法正确处理。使用 socketserver + 手动解析 chunked 编码来修复。
"""

import gzip
import json
import os
import re
import socket
import sys
import threading
from datetime import datetime

LISTEN_PORT = 4318
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "otel_data")
METRICS_LOG = os.path.join(LOG_DIR, "metrics.jsonl")
LOGS_LOG = os.path.join(LOG_DIR, "logs.jsonl")
RAW_LOG = os.path.join(LOG_DIR, "raw_requests.jsonl")

stats = {"requests": 0}
lock = threading.Lock()


def extract_attributes(attrs):
    result = {}
    if not isinstance(attrs, list):
        return result
    for attr in attrs:
        key = attr.get("key", "")
        value = attr.get("value", {})
        if isinstance(value, dict):
            for vtype in ["stringValue", "intValue", "doubleValue", "boolValue"]:
                if vtype in value:
                    result[key] = value[vtype]
                    break
        else:
            result[key] = value
    return result


def write_log(filepath, record):
    try:
        with open(filepath, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except Exception as e:
        print(f"  ⚠️ 写入失败: {e}", flush=True)


def read_chunked(conn):
    """手动读取 chunked transfer encoding 数据"""
    data = b""
    while True:
        # 读取 chunk size 行
        size_line = b""
        while not size_line.endswith(b"\r\n"):
            byte = conn.recv(1)
            if not byte:
                return data
            size_line += byte

        # 解析 chunk size
        size_str = size_line.strip().decode("ascii", errors="ignore").split(";")[0]
        try:
            chunk_size = int(size_str, 16)
        except ValueError:
            return data

        if chunk_size == 0:
            # 读取 trailing \r\n
            conn.recv(2)
            break

        # 读取 chunk 数据
        chunk = b""
        remaining = chunk_size
        while remaining > 0:
            part = conn.recv(min(remaining, 65536))
            if not part:
                return data
            chunk += part
            remaining -= len(part)
        data += chunk

        # 读取 chunk 后的 \r\n
        conn.recv(2)

    return data


def handle_connection(conn, addr):
    """处理单个 HTTP 连接"""
    try:
        # 读取请求头
        header_data = b""
        while b"\r\n\r\n" not in header_data:
            chunk = conn.recv(4096)
            if not chunk:
                return
            header_data += chunk

        # 分离 header 和可能的 body 前段
        header_end = header_data.index(b"\r\n\r\n") + 4
        header_bytes = header_data[:header_end]
        body_start = header_data[header_end:]

        # 解析请求行和 headers
        header_text = header_bytes.decode("utf-8", errors="replace")
        lines = header_text.split("\r\n")
        request_line = lines[0]
        parts = request_line.split(" ")
        method = parts[0] if len(parts) > 0 else "?"
        path = parts[1] if len(parts) > 1 else "?"

        headers = {}
        for line in lines[1:]:
            if ": " in line:
                k, v = line.split(": ", 1)
                headers[k.lower()] = v

        with lock:
            stats["requests"] += 1
            req_num = stats["requests"]

        timestamp = datetime.now().isoformat()
        content_length = int(headers.get("content-length", -1))
        transfer_encoding = headers.get("transfer-encoding", "")
        content_type = headers.get("content-type", "unknown")
        content_encoding = headers.get("content-encoding", "none")

        # 处理 OPTIONS
        if method == "OPTIONS":
            response = "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: 0\r\n\r\n"
            conn.sendall(response.encode())
            return

        # 读取 body
        body_raw = b""
        if "chunked" in transfer_encoding:
            # chunked 编码：body_start 包含了 chunked 数据的开头
            # 我们需要把 body_start 和后续数据拼起来处理
            # 简化：用临时方式处理
            all_data = body_start
            conn.settimeout(2.0)
            try:
                while True:
                    more = conn.recv(65536)
                    if not more:
                        break
                    all_data += more
            except socket.timeout:
                pass

            # 解析 chunked 编码
            body_raw = decode_chunked(all_data)

        elif content_length > 0:
            body_raw = body_start
            remaining = content_length - len(body_start)
            while remaining > 0:
                chunk = conn.recv(min(remaining, 65536))
                if not chunk:
                    break
                body_raw += chunk
                remaining -= len(chunk)

        elif content_length == 0:
            body_raw = b""
        else:
            # 没有 content-length 也没有 chunked，尝试读取
            body_raw = body_start
            conn.settimeout(1.0)
            try:
                while True:
                    more = conn.recv(65536)
                    if not more:
                        break
                    body_raw += more
            except socket.timeout:
                pass

        print(f"\n{'='*60}", flush=True)
        print(f"[#{req_num}] {timestamp}", flush=True)
        print(f"  {method} {path}", flush=True)
        print(f"  Content-Type: {content_type}", flush=True)
        print(f"  Content-Length: {content_length}", flush=True)
        print(f"  Transfer-Encoding: {transfer_encoding or 'none'}", flush=True)
        print(f"  Content-Encoding: {content_encoding}", flush=True)
        print(f"  Body size: {len(body_raw)} bytes", flush=True)

        # gzip 解压
        decoded_body = body_raw
        if body_raw[:2] == b"\x1f\x8b" or content_encoding == "gzip":
            try:
                decoded_body = gzip.decompress(body_raw)
                print(
                    f"  ✅ gzip: {len(body_raw)} → {len(decoded_body)} bytes",
                    flush=True,
                )
            except Exception as e:
                print(f"  ❌ gzip 失败: {e}", flush=True)

        # JSON 解析
        body = None
        if len(decoded_body) > 0:
            try:
                body = json.loads(decoded_body.decode("utf-8", errors="replace"))
                keys = (
                    list(body.keys()) if isinstance(body, dict) else type(body).__name__
                )
                print(f"  ✅ JSON 解析成功! keys: {keys}", flush=True)
            except Exception as e:
                print(f"  ❌ JSON 失败: {e}", flush=True)
                print(f"  Preview: {decoded_body[:300]}", flush=True)
        else:
            print(f"  ⚠️ Body 为空", flush=True)

        # 记录 raw
        raw_record = {
            "req_num": req_num,
            "timestamp": timestamp,
            "path": path,
            "content_type": content_type,
            "content_length": content_length,
            "transfer_encoding": transfer_encoding,
            "body_size": len(body_raw),
            "decoded_size": len(decoded_body),
            "parsed": body is not None,
        }
        write_log(RAW_LOG, raw_record)

        # 处理数据
        if body and isinstance(body, dict):
            path_clean = path.rstrip("/").split("?")[0]
            if path_clean.endswith("/v1/metrics"):
                process_metrics(body, timestamp)
            elif path_clean.endswith("/v1/logs"):
                process_logs(body, timestamp)
            else:
                print(f"  📝 未知路径: {path_clean}", flush=True)

        # 返回 200
        resp_body = json.dumps({"partialSuccess": {}}).encode()
        response = (
            f"HTTP/1.1 200 OK\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(resp_body)}\r\n"
            f"Connection: close\r\n"
            f"\r\n"
        )
        conn.sendall(response.encode() + resp_body)

    except Exception as e:
        print(f"  ❌ 连接处理错误: {e}", flush=True)
        try:
            resp = "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            conn.sendall(resp.encode())
        except:
            pass
    finally:
        try:
            conn.close()
        except:
            pass


def decode_chunked(data):
    """解码 chunked transfer encoding"""
    result = b""
    pos = 0
    while pos < len(data):
        # 找到 chunk size 行的结尾
        end = data.find(b"\r\n", pos)
        if end == -1:
            break

        size_str = data[pos:end].decode("ascii", errors="ignore").split(";")[0].strip()
        try:
            chunk_size = int(size_str, 16)
        except ValueError:
            break

        if chunk_size == 0:
            break

        # 提取 chunk 数据
        chunk_start = end + 2
        chunk_end = chunk_start + chunk_size
        if chunk_end > len(data):
            # 不完整的 chunk，取能取的
            result += data[chunk_start:]
            break
        result += data[chunk_start:chunk_end]

        # 跳过 chunk 后的 \r\n
        pos = chunk_end + 2

    return result


def process_metrics(body, timestamp):
    count = 0
    for rm in body.get("resourceMetrics", []):
        resource = extract_attributes(rm.get("resource", {}).get("attributes", []))
        for sm in rm.get("scopeMetrics", []):
            for metric in sm.get("metrics", []):
                name = metric.get("name", "?")
                for dtype in ["sum", "gauge", "histogram"]:
                    obj = metric.get(dtype)
                    if obj:
                        for dp in obj.get("dataPoints", []):
                            count += 1
                            value = (
                                dp.get("asInt")
                                or dp.get("asDouble")
                                or dp.get("value", "?")
                            )
                            attrs = extract_attributes(dp.get("attributes", []))
                            attrs_str = " ".join(f"{k}={v}" for k, v in attrs.items())
                            print(f"  📊 {name} = {value}  [{attrs_str}]", flush=True)
                            write_log(
                                METRICS_LOG,
                                {
                                    "timestamp": timestamp,
                                    "metric_name": name,
                                    "value": value,
                                    "attributes": attrs,
                                    "resource": resource,
                                },
                            )
    print(f"  → {count} metric points", flush=True)


def process_logs(body, timestamp):
    count = 0
    for rl in body.get("resourceLogs", []):
        resource = extract_attributes(rl.get("resource", {}).get("attributes", []))
        for sl in rl.get("scopeLogs", []):
            for lr in sl.get("logRecords", []):
                count += 1
                log_body = lr.get("body", {})
                body_str = (
                    log_body.get("stringValue", "")
                    if isinstance(log_body, dict)
                    else str(log_body)
                )
                try:
                    body_parsed = json.loads(body_str) if body_str else None
                except:
                    body_parsed = body_str

                attrs = extract_attributes(lr.get("attributes", []))
                event_name = attrs.get("event.name", "unknown")

                write_log(
                    LOGS_LOG,
                    {
                        "timestamp": timestamp,
                        "event_name": event_name,
                        "severity": lr.get("severityText", ""),
                        "attributes": attrs,
                        "body": body_parsed,
                        "resource": resource,
                    },
                )

                icons = {
                    "user_prompt": "💬",
                    "tool_result": "🔧",
                    "api_request": "🌐",
                    "api_error": "❌",
                    "tool_decision": "⚖️",
                }
                icon = icons.get(event_name, "📝")

                if event_name == "api_request":
                    print(
                        f"  {icon} [{event_name}] model={attrs.get('model','?')} "
                        f"cost=${attrs.get('cost_usd','?')} dur={attrs.get('duration_ms','?')}ms "
                        f"in={attrs.get('input_tokens','?')} out={attrs.get('output_tokens','?')}",
                        flush=True,
                    )
                elif event_name == "tool_result":
                    print(
                        f"  {icon} [{event_name}] tool={attrs.get('tool_name','?')} "
                        f"success={attrs.get('success','?')} dur={attrs.get('duration_ms','?')}ms",
                        flush=True,
                    )
                elif event_name == "user_prompt":
                    prompt = str(attrs.get("prompt", "(redacted)"))
                    print(
                        f"  {icon} [{event_name}] len={attrs.get('prompt_length','?')} "
                        f'"{prompt[:100]}"',
                        flush=True,
                    )
                elif event_name == "tool_decision":
                    print(
                        f"  {icon} [{event_name}] tool={attrs.get('tool_name','?')} "
                        f"decision={attrs.get('decision','?')}",
                        flush=True,
                    )
                else:
                    preview = " ".join(f"{k}={v}" for k, v in list(attrs.items())[:5])
                    print(f"  {icon} [{event_name}] {preview}", flush=True)
    print(f"  → {count} log records", flush=True)


def print_summary():
    print(f"\n{'='*60}")
    print(f"📊 OTEL 数据采集摘要")
    print(f"{'='*60}")

    # Raw
    print(f"\n--- 请求概览 ---")
    if os.path.exists(RAW_LOG):
        raws = [json.loads(l) for l in open(RAW_LOG) if l.strip()]
        print(f"  总请求数: {len(raws)}")
        for r in raws:
            print(
                f"  [{r['req_num']}] {r['path']} | body={r['body_size']}B decoded={r['decoded_size']}B parsed={r['parsed']}"
            )
    else:
        print("  （无）")

    # Metrics
    print(f"\n--- Metrics ---")
    if os.path.exists(METRICS_LOG):
        records = [json.loads(l) for l in open(METRICS_LOG) if l.strip()]
        print(f"  数据点: {len(records)}")
        names = {}
        for r in records:
            n = r["metric_name"]
            names[n] = names.get(n, 0) + 1
        for n, c in sorted(names.items()):
            print(f"    {n}: {c}个点")
        if records and records[0].get("resource"):
            print(f"\n  Resource:")
            for k, v in records[0]["resource"].items():
                print(f"    {k}: {v}")
    else:
        print("  （无）")

    # Logs
    print(f"\n--- Events ---")
    if os.path.exists(LOGS_LOG):
        records = [json.loads(l) for l in open(LOGS_LOG) if l.strip()]
        print(f"  事件数: {len(records)}")

        types = {}
        models = set()
        tools = {}
        cost = 0
        tok_in = 0
        tok_out = 0

        for r in records:
            en = r["event_name"]
            a = r.get("attributes", {})
            types[en] = types.get(en, 0) + 1
            if a.get("model"):
                models.add(a["model"])
            if a.get("tool_name"):
                tools[a["tool_name"]] = tools.get(a["tool_name"], 0) + 1
            if en == "api_request":
                try:
                    cost += float(a.get("cost_usd", 0))
                    tok_in += int(a.get("input_tokens", 0))
                    tok_out += int(a.get("output_tokens", 0))
                except:
                    pass

        print(f"\n  事件类型:")
        for en, c in sorted(types.items(), key=lambda x: -x[1]):
            print(f"    {en}: {c}次")

        print(f"\n  模型: {sorted(models) if models else '（无）'}")
        if tools:
            print(f"\n  工具:")
            for t, c in sorted(tools.items(), key=lambda x: -x[1])[:20]:
                print(f"    {t}: {c}次")
        print(f"\n  Tokens: in={tok_in:,} out={tok_out:,} cost=${cost:.6f}")

        # API 请求详情
        apis = [r for r in records if r["event_name"] == "api_request"]
        if apis:
            print(f"\n  API 请求 ({len(apis)}次):")
            for i, r in enumerate(apis):
                a = r["attributes"]
                print(
                    f"    [{i+1}] model={a.get('model')} cost=${a.get('cost_usd','?')} "
                    f"dur={a.get('duration_ms','?')}ms in={a.get('input_tokens','?')} "
                    f"out={a.get('output_tokens','?')} cache_read={a.get('cache_read_tokens','?')}"
                )

        prompts = [r for r in records if r["event_name"] == "user_prompt"]
        if prompts:
            print(f"\n  Prompts ({len(prompts)}条):")
            for i, r in enumerate(prompts):
                a = r["attributes"]
                print(
                    f"    [{i+1}] len={a.get('prompt_length','?')}: \"{str(a.get('prompt',''))[:200]}\""
                )

        # 第一条完整记录
        if records:
            print(f"\n  === 第一条完整事件 ===")
            print(json.dumps(records[0], indent=2, ensure_ascii=False)[:2000])

        if records and records[0].get("resource"):
            print(f"\n  Resource:")
            for k, v in records[0]["resource"].items():
                print(f"    {k}: {v}")
    else:
        print("  （无）")
    print(f"\n{'='*60}")


def main():
    os.makedirs(LOG_DIR, exist_ok=True)
    for f in [METRICS_LOG, LOGS_LOG, RAW_LOG]:
        if os.path.exists(f):
            try:
                os.rename(f, f + ".bak")
            except:
                pass

    print("=" * 60, flush=True)
    print("📡 OTEL Receiver v3 - 支持 Chunked Transfer Encoding", flush=True)
    print("=" * 60, flush=True)
    print(f"\n  监听: 0.0.0.0:{LISTEN_PORT}", flush=True)
    print(f"  日志: {LOG_DIR}", flush=True)
    print(f"\n  启动 Claude Code:", flush=True)
    print(f"  export CLAUDE_CODE_ENABLE_TELEMETRY=1", flush=True)
    print(f"  export OTEL_METRICS_EXPORTER=otlp", flush=True)
    print(f"  export OTEL_LOGS_EXPORTER=otlp", flush=True)
    print(f"  export OTEL_EXPORTER_OTLP_PROTOCOL=http/json", flush=True)
    print(
        f"  export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:{LISTEN_PORT}",
        flush=True,
    )
    print(f"  export OTEL_LOG_USER_PROMPTS=1", flush=True)
    print(f"  export OTEL_LOG_TOOL_DETAILS=1", flush=True)
    print(f"  export OTEL_METRIC_EXPORT_INTERVAL=10000", flush=True)
    print(f"  export OTEL_LOGS_EXPORT_INTERVAL=5000", flush=True)
    print(f"  claude", flush=True)
    print("=" * 60, flush=True)

    # 创建 socket 服务器
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", LISTEN_PORT))
    server.listen(10)
    server.settimeout(1.0)

    print(f"\n✅ 已启动，等待数据...\n", flush=True)

    try:
        while True:
            try:
                conn, addr = server.accept()
                t = threading.Thread(
                    target=handle_connection, args=(conn, addr), daemon=True
                )
                t.start()
            except socket.timeout:
                continue
    except KeyboardInterrupt:
        print("\n🛑 已停止", flush=True)
        print_summary()
        server.close()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--summary":
        print_summary()
    else:
        main()
