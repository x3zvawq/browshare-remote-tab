# Remote Tab 实现与验收进度

## 项目设计与工程基础

- [x] MIT 许可证、README、贡献指南和安全策略
- [x] Remote Tab 与 BrowShare 的仓库职责边界
- [x] Google Chrome Stable 术语与兼容性口径
- [x] 独立 Remote Tab 品牌图标和页面设计规范
- [x] pnpm workspace、严格 TypeScript 与统一构建入口
- [x] Core、Protocol、Headless Client、Viewer、Extension 的 tsdown 包结构
- [x] Signaling、Standalone、Embed 示例与 Extension 签名工具结构
- [x] 冻结首个稳定公共 API、协议主版本和兼容性集合

## 公共协议与能力协商

- [x] MessagePack 协议包络、Session 绑定、Viewer generation 与 sequence
- [x] TypeBox 运行时 schema、大小限制和未知消息处理
- [x] 稳定错误码、结构化错误和可重试语义
- [x] Capability 协商和规范化
- [x] Viewer Ticket 声明、HMAC 签发、消费和过期语义
- [x] Gateway 信令消息与 ICE 配置
- [x] Extension loopback 身份、捕获、媒体和诊断消息
- [x] 输入、导航、viewport、生命周期和画质消息
- [x] 上传、结构化 Notice 与本机打开消息
- [x] 下载消息的完整客户端消费与交付语义
- [x] 文本与图片剪贴板消息
- [x] 固定 `browshare:*` Page Script 生命周期事件消息

## Core 与 Session 生命周期

- [x] 浏览器级 CDP 连接、版本读取和显式失败
- [x] 创建或接管单个 Tab，并建立 `Session ↔ targetId ↔ tabId` 映射
- [x] viewport 确认、鼠标、滚轮、拖拽、键盘、IME 和 Emoji 输入
- [x] URL 导航、前进、后退和刷新授权钩子，真实主文档逐跳确认、取消与观测地址同步
- [x] Session 状态机、单 Viewer、generation 接管和旧输入拒绝
- [x] suspend、resume、断线回连、关闭和确定性清理
- [x] 三档画质、Tab 音频、ICE restart 和媒体诊断
- [x] 文件选择器拦截、上传限额、连续分块和存储适配器
- [x] 新上下文拦截、维护模式 `retain` 后代窗口归属与清理、重复接管拒绝及本机打开授权
- [x] 结构化 Notice 发送接口
- [x] 可关联 Notice 请求、响应、取消、Viewer 弹窗和真实 Chrome/WebRTC 生命周期验证
- [x] 下载 GUID 的 Session 归属、spool 管理、背压传输和完整清理
- [x] 剪贴板读写的显式用户动作边界
- [x] Page Script 固定事件的触发和 MAIN world 投递
- [x] Chrome/CDP 断开后的 Standalone 状态对账

## Extension 与 Chrome 媒体运行时

- [x] 固定 ID、Managed Policy 配置和 loopback 双角色认证
- [x] 全新 Chrome 首次强制安装的 Managed Storage 时序恢复与并发捕获
- [x] 已安装持久 Profile 连续多代重启的扩展自主就绪稳定性
- [x] 多 Chrome Runtime 的 Extension loopback 发现、隔离和 Session 路由
- [x] `targetId → tabId` 解析与单 Tab `tabCapture`
- [x] 视频和可选 Tab 音频的 WebRTC Publisher
- [x] reliable、realtime、file-transfer 三 DataChannel
- [x] Viewer 离开、暂停恢复、质量调整和 ICE restart
- [x] file-transfer buffered amount 背压与逐块转发确认
- [x] MAIN world `window.open()` 新上下文拦截
- [x] 下载领取端到端链路的真实 Extension 验证
- [x] 文本与图片剪贴板桥接
- [x] 固定 `browshare:*` Page Script 事件桥接
- [x] 发布版 Extension 版本、CRX、update manifest 和升级诊断

## Gateway 与信令

- [x] Core 与 Viewer 的认证配对
- [x] 单次 Viewer Ticket、超时、重放和错误关闭语义
- [x] SDP、ICE candidate 和 restart-ice 转发
- [x] 媒体与文件不经过 Gateway 的数据面边界
- [x] Gateway CLI、健康检查和结构化日志
- [x] 面向正式发布的限流、容量指标和部署基线

## Headless Client

- [x] Ticket 连接、PeerConnection、媒体流和三 DataChannel
- [x] Capability、viewport、状态、Notice 和诊断事件
- [x] 输入、导航、画质和 suspend/resume API
- [x] 有界 ICE restart 与获取新 Ticket 的自动重连
- [x] 新窗口 URL 的本机打开请求与结果 API
- [x] 上传选择请求、Blob 分块、进度、取消和背压
- [x] 下载请求、接受/拒绝、连续偏移校验和 Blob 组装 API
- [x] 下载进度、完成、取消和断线清理事件
- [x] 文本与图片剪贴板 API
- [x] Page Script 事件 API

## Viewer 页面与嵌入体验

- [x] 框架无关自定义元素、Shadow DOM 和公共生命周期 API
- [x] 视频画面、加载、断线、暂停和错误状态
- [x] 鼠标、滚轮、拖拽、键盘、快捷键、IME 和 Emoji
- [x] URL 栏、前进、后退、刷新和远端 viewport 映射
- [x] 自动失焦暂停、手动恢复和遮罩交互
- [x] 画质、全屏、音量、静音和连接诊断
- [x] 自动与自定义画质、网络和编码压力自适应及真实媒体验收
- [x] 中文与英文界面文案
- [x] 上传选择、进度、取消和失败反馈
- [x] “是否在本机打开？”确认和结构化 Notice
- [x] 可嵌入事件边界与 element-local `error` 事件
- [x] 下载确认、进度、取消、保存和宿主覆盖 API
- [x] 文本与图片剪贴板及浏览器权限回退 UI
- [x] Page Script 事件对宿主的公开事件
- [x] Chrome、Edge、Safari、Firefox 桌面兼容性矩阵
- [x] 移动浏览器的明确支持级别与降级体验

## Standalone 与嵌入示例

- [x] Standalone daemon、认证 API 和 Session CRUD
- [x] Embedder hooks、Viewer Ticket 和 Gateway 分配适配
- [x] 临时上传存储、Session 隔离与结束清理
- [x] Notice API、维护模式与 child-target 策略
- [x] Headless Client、Viewer 和 Core 的包导出与 Embed 示例
- [x] Chrome 与 Extension capability probe 和版本诊断
- [x] 独立下载 spool 的创建、过期、启动清扫和关闭清理
- [x] Clipboard 与 Page Script 的 Standalone 示例接口
- [x] 第三方仅按 README 即可完成的全新环境部署演练

## 部署、安全与可观测性

- [x] Extension 固定 ID 签名、CRX 检查和 managed policy 模板
- [x] direct ICE、TURN/UDP、TURN/TCP 与 TURN/TLS 配置
- [x] 健康检查、结构化日志和 WebRTC 指标基础
- [x] 敏感信息不进入日志的文档边界
- [x] Prometheus 指标、容量告警和运行手册
- [x] All-in-one 与拆分部署的 Compose 示例
- [x] 非 root Chrome sandbox 与 deny-by-default seccomp profile
- [x] Chrome/Extension/Core 协调升级与回滚流程
- [x] CI 构建、检查、制品留存和发布门禁
- [x] npm 包、容器镜像、SBOM、校验和与来源证明

## 真实链路与兼容性验收

- [x] 单 Tab Google Chrome Stable 视频、输入、导航和清理
- [x] 四并发 Tab 的画面、输入和生命周期隔离
- [x] Viewer 接管、断线重连和多轮生命周期 soak
- [x] 四 Session 独立暂停与恢复
- [x] direct ICE 与 TURN/UDP、TURN/TCP、TURN/TLS
- [x] 画质调整、ICE restart 和周期媒体指标
- [x] 上传、取消、恶意文件名和临时文件清理
- [x] 新窗口本机打开、维护模式 child target 与 Notice
- [x] 接管前附属窗口归属发现、窗口目录事件、冲突接管与 CDP 附属输入实测
- [x] Extension 捕获替换确认、同 Peer 音视频切换、暂停与失败清理的真实 Chrome/WebRTC 实测
- [x] 维护窗口选择、媒体轨道切换与跨窗口输入绑定实测
- [x] 每 Session 媒体上限、初始编码参数与 Viewer 实际应用值实测
- [x] 两个并发 Session 下载不同内容且无串文件
- [x] 下载接受、拒绝、断线、超限、超时和零 spool 残留
- [x] 文本与图片剪贴板的权限允许、拒绝和手工回退
- [x] Page Script 固定事件的导航、刷新、失败、清理及主文档结构化 Notice 请求与结果路由
- [x] 首次完整 Gate 0 复跑并冻结公共接口（Extension 0.1.14）
- [x] 当前 0.1.23 候选完整 Direct/TURN Gate 与四桌面浏览器矩阵复跑
- [x] 重启、崩溃、孤儿 Target 和临时文件对账
- [x] 发布候选版安全审查与第三方部署复现

## 发布准备与外部发布

- [x] 协议与公共 API 版本冻结
- [x] 所有包使用协调的非零版本
- [x] MIT 源码发布和完整 CHANGELOG
- [ ] npm 包发布
- [ ] GHCR 镜像发布
- [ ] 签名 CRX、update manifest 和校验和发布
- [x] SBOM、兼容性表与安全审查记录
- [x] 安装、升级、回滚和故障排查文档
