'use strict'

const fs = require('node:fs')
const path = require('node:path')
const source = path.resolve(__dirname, '../../../packages/project-config/index.cjs')
module.exports = require(fs.existsSync(source) ? source : path.resolve(__dirname, '../packages/project-config/index.cjs'))
