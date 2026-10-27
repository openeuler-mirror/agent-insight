'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs')
const path = require('node:path')
const source = path.resolve(__dirname, '../../../packages/agent-runtime/loader.cjs')
module.exports = require(fs.existsSync(source) ? source : path.resolve(__dirname, '../packages/agent-runtime/loader.cjs'))
