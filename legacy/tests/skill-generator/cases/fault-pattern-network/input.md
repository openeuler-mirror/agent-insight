以下是一组网络层故障模式，请使用 --auto 模式生成排查 Skill，输出到 OUTPUT_DIR。

## 故障域

OS > 网络 > 连通性

## 失效模型列表

| 编号 | 名称 | 描述 | 检测方法 | 恢复方法 |
|------|------|------|----------|----------|
| NW-01 | IP 路由不可达 | 目标 IP 无路由条目，导致连接超时 | `ip route get <dst>` 返回 unreachable | 添加路由：`ip route add <dst> via <gw>` |
| NW-02 | iptables 规则拦截 | INPUT/FORWARD 链存在 DROP 规则，报文被丢弃 | `iptables -L -n -v` 查看规则计数器增长 | 删除对应规则：`iptables -D INPUT <rule_num>` |
| NW-03 | 网卡 MTU 不匹配 | 两端 MTU 不一致导致大包丢失，小包正常 | `ping -s 1472 <dst>` 失败而 `ping -s 64` 成功 | 调整 MTU：`ip link set eth0 mtu 1500` |
| NW-04 | DNS 解析失败 | 域名无法解析，但 IP 访问正常 | `dig <domain>` 超时，`curl <ip>` 正常 | 检查 `/etc/resolv.conf`，更换 DNS 服务器 |
| NW-05 | 网卡 Down 状态 | 网卡处于 down 状态，所有流量中断 | `ip link show eth0` 显示 DOWN | `ip link set eth0 up` 并检查物理连接 |
