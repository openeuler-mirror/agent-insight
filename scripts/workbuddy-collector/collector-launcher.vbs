' WorkBuddy Collector 隐藏窗口启动器（模板 / 参考）。
'
' 计划任务直接跑 node.exe 会在登录瞬间闪一下控制台黑框，体验差。用 WScript
' 以隐藏窗口（第二个参数 0）启动采集器即可全程无感。
'
' 注意：authoritative 版本由 workbuddy_setup.mjs 在安装时生成，会把 node.exe 与
' collector.mjs 的绝对路径写死。本文件是通用回退版：从 PATH 找 node，脚本取与自身
' 同目录的 collector.mjs。
Dim shell, fso, here, collector
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
collector = here & "\collector.mjs"
shell.Run "node.exe " & Chr(34) & collector & Chr(34), 0, False
