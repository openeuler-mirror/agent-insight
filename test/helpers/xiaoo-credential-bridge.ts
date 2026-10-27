import fs from 'node:fs'
import path from 'node:path'

export function writeXiaooCredentialBridge(directory: string, llm: Record<string, unknown>, response?: Record<string, unknown>) {
  const file = path.join(directory, 'insight-xiaoo-credentials')
  fs.writeFileSync(file, `#!${process.execPath}\nconst fs=require('node:fs'); let input=''; process.stdin.on('data',x=>input+=x); process.stdin.on('end',()=>{JSON.parse(input); const llm=${JSON.stringify(llm)}; fs.writeSync(3,JSON.stringify(${response ? JSON.stringify(response) : '{schemaVersion:1,llm,credential:process.env[llm.api_key_env]}' }));});\n`, { mode: 0o755 })
  return file
}
