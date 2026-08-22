# coding: utf-8
"""Embedding transports for platform adapters.

Two modes (do not conflate with SessionHub / ras_runtime core):

- ``inproc`` — host process keeps RAS state (OpenCode plugin).
- ``subprocess_ipc`` — short-lived hook subprocesses share one SessionHub
  worker over a Unix socket (xiaoo-style stdin hooks).
"""
