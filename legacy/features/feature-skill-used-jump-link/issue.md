#52: 【feature】执行记录中skill used增加跳转功能
状态: open | 创建: 2026-03-10 | 更新: 2026-03-13
标签: sig/sig-intelligence
链接: https://atomgit.com/openeuler/witty-skill-insight/issues/52

--- Issue Content ---
**1、背景与价值**
在Witty-Skill-Insight平台中，执行记录中的skill used字段当前仅以字符串形式显示，展示实际执行过程中使用的skill名称。用户无法直接从执行记录跳转到对应的skill详情页面查看skill的完整信息。增加跳转功能可以让用户快速查看skill详情，提升使用体验和操作效率。

**2、需求详情**
- 跳转功能：在执行记录的skill used字段上增加点击跳转功能
- 跳转目标：点击skill名字后跳转到对应的skill详情页面
- 视觉提示：将skill used字符串改为可点击的链接样式，添加适当的视觉提示（如颜色、下划线、hover效果）
- 保持显示：跳转功能不改变skill used的显示内容，仍然显示实际执行的skill名称
- 多skill支持：如果执行记录中有多个skill，每个skill都应该支持跳转
- 错误处理：如果skill不存在或已被删除，提供友好的错误提示

**3、验收标准**
一：跳转功能正常
点击skill used字段中的skill名称能够正确跳转到对应的skill详情页面。

二：视觉提示清晰
skill名称有明显的可点击样式提示，用户能够识别这是可跳转的链接。

三：显示内容不变
跳转功能不改变skill used字段的显示内容，仍然显示实际执行的skill名称。

四：多skill支持
如果执行记录中有多个skill，每个skill都能正确跳转到对应的详情页面。

五：错误处理友好
当skill不存在或已被删除时，能够提供友好的错误提示。
