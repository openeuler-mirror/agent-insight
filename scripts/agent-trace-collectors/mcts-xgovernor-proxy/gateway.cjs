#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const http = require("node:http");
const https = require("node:https");
const { randomUUID } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");

const JSON_OPERATIONS = new Set(["open", "load", "checkpoint", "turns", "close", "cancel", "heartbeat", "files/read"]);
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function operationOf(pathname) {
  const prefix = "/api/v1/sessions/";
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (/^[^/]+\/turns\/[^/]+\/events$/.test(rest)) return "events";
  return rest;
}

function inspectableJson(pathname) {
  return JSON_OPERATIONS.has(operationOf(pathname));
}

function forwardedHeaders(headers, upstream) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  }
  result.host = upstream.host;
  return result;
}

function responseHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  }
  return result;
}

function parseJson(chunks, size, limit) {
  if (size > limit) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    return undefined;
  }
}

function parseSsePath(pathname) {
  const match = /^\/api\/v1\/sessions\/([^/]+)\/turns\/([^/]+)\/events$/.exec(pathname);
  if (!match) return {};
  try {
    return { runtimeId: decodeURIComponent(match[1]), turnId: decodeURIComponent(match[2]) };
  } catch {
    return {};
  }
}

function createSseTap(pathname, onEvent) {
  const decoder = new StringDecoder("utf8");
  const identity = parseSsePath(pathname);
  let buffer = "";
  let data = [];
  const consume = (line) => {
    if (line === "") {
      if (data.length) {
        try {
          const event = JSON.parse(data.join("\n"));
          Promise.resolve(onEvent?.({ ...identity, event, receivedAt: Date.now() })).catch(() => undefined);
        } catch {}
      }
      data = [];
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  };
  return {
    write(chunk) {
      buffer += decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        consume(line);
      }
    },
    end() {
      buffer += decoder.end();
      if (buffer) consume(buffer.replace(/\r$/, ""));
      consume("");
    },
  };
}

async function createGateway(options) {
  const upstream = new URL(options.upstreamUrl);
  if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error("xGovernor upstream must use HTTP(S)");
  if (upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error("xGovernor upstream URL cannot include credentials, query or fragment");
  const transport = upstream.protocol === "https:" ? https : http;
  const maxInspectBytes = options.maxInspectBytes || 512 * 1024;

  const server = http.createServer((request, response) => {
    const id = randomUUID();
    const startedAt = Date.now();
    const requestUrl = new URL(request.url || "/", "http://agent-insight.local");
    const pathname = requestUrl.pathname;
    const collectRequest = request.method !== "GET" && inspectableJson(pathname);
    const requestChunks = [];
    let requestSize = 0;

    const upstreamRequest = transport.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || undefined,
      method: request.method,
      path: `${upstream.pathname.replace(/\/$/, "")}${request.url || "/"}`,
      headers: forwardedHeaders(request.headers, upstream),
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders(upstreamResponse.headers));
      const contentType = String(upstreamResponse.headers["content-type"] || "").toLowerCase();
      const collectResponse = inspectableJson(pathname) && contentType.includes("json");
      const responseChunks = [];
      let responseSize = 0;
      const sseTap = operationOf(pathname) === "events" ? createSseTap(pathname, options.onSseEvent) : undefined;
      upstreamResponse.on("data", (chunk) => {
        response.write(chunk);
        if (collectResponse && responseSize <= maxInspectBytes) {
          responseSize += chunk.length;
          if (responseSize <= maxInspectBytes) responseChunks.push(chunk);
        }
        sseTap?.write(chunk);
      });
      upstreamResponse.on("end", () => {
        sseTap?.end();
        response.end();
        Promise.resolve(options.onResponse?.({
          id,
          path: pathname,
          status: upstreamResponse.statusCode || 0,
          body: collectResponse ? parseJson(responseChunks, responseSize, maxInspectBytes) : undefined,
          endedAt: Date.now(),
        })).catch(() => undefined);
      });
      upstreamResponse.on("error", () => response.destroy());
    });

    upstreamRequest.on("error", (error) => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "xGovernor upstream unavailable" }));
      } else response.destroy(error);
    });
    request.on("data", (chunk) => {
      upstreamRequest.write(chunk);
      if (collectRequest && requestSize <= maxInspectBytes) {
        requestSize += chunk.length;
        if (requestSize <= maxInspectBytes) requestChunks.push(chunk);
      }
    });
    request.on("end", () => {
      upstreamRequest.end();
      Promise.resolve(options.onRequest?.({
        id,
        method: request.method,
        path: pathname,
        body: collectRequest ? parseJson(requestChunks, requestSize, maxInspectBytes) : undefined,
        startedAt,
      })).catch(() => undefined);
    });
    request.on("aborted", () => upstreamRequest.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  return {
    server,
    port: address.port,
    url,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

module.exports = { createGateway, createSseTap, inspectableJson, operationOf, parseSsePath, responseHeaders };
