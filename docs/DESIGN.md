---
version: "alpha"
name: BrowShare Remote Tab Viewer
description: An immersive remote web control surface that keeps browser content dominant.
colors:
  primary: "#0F62D6"
  brand-primary-hover: "#4096FF"
  brand-primary-pressed: "#0958D9"
  signal-coral: "#FF6B5F"
  signal-coral-hover: "#FF897F"
  canvas: "#060A12"
  surface: "#101724"
  surface-raised: "#182234"
  surface-glass: "rgba(16, 23, 36, 0.88)"
  video-placeholder: "#0A0F19"
  text-primary: "#F5F8FF"
  text-secondary: "#A8B3C7"
  border: "#293449"
  focus: "#6AAEFF"
  success: "#36AD6A"
  warning: "#F2C97D"
  danger: "#E88080"
  info: "#70C0E8"
typography:
  heading:
    fontFamily: "Inter, PingFang SC, Noto Sans SC, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1.4
  body:
    fontFamily: "Inter, PingFang SC, Noto Sans SC, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "Inter, PingFang SC, Noto Sans SC, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 550
    lineHeight: 1.35
  mono:
    fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "4px"
  sm: "7px"
  md: "11px"
  lg: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  control-bar:
    backgroundColor: "{colors.surface-glass}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "6px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    height: "32px"
    width: "32px"
  icon-button-active:
    backgroundColor: "{colors.primary}"
    textColor: "#FFFFFF"
  icon-button-active-hover:
    backgroundColor: "{colors.brand-primary-hover}"
  icon-button-active-pressed:
    backgroundColor: "{colors.brand-primary-pressed}"
  notice:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
  reconnect-overlay:
    backgroundColor: "rgba(6, 10, 18, 0.84)"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "24px"
  viewer-canvas:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-primary}"
  viewport-placeholder:
    backgroundColor: "{colors.video-placeholder}"
    textColor: "{colors.text-secondary}"
  divider:
    backgroundColor: "{colors.border}"
  focus-ring:
    backgroundColor: "{colors.focus}"
  remote-control-active:
    backgroundColor: "{colors.signal-coral}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.sm}"
  remote-control-active-hover:
    backgroundColor: "{colors.signal-coral-hover}"
  status-success:
    textColor: "{colors.success}"
  status-warning:
    textColor: "{colors.warning}"
  status-danger:
    textColor: "{colors.danger}"
  status-info:
    textColor: "{colors.info}"
---

# Remote Tab Viewer design

## Overview

Viewer的第一视觉主体永远是远端网页。控制界面应当像专业媒体播放器和浏览器工具条的结合：在需要时清楚可达，不操作时主动退后。设计继承BrowShare的品牌蓝，并使用少量珊瑚色表达“远程交互/信号”，但不复制平台后台的卡片布局。

基础交互遵循Material Design 3关于可点击面积、焦点、状态和无障碍的原则。Viewer本身不依赖Naive UI，以便作为Web Component嵌入任何框架。

## Colors

- 默认使用深色画布，减少视频边缘闪烁和视觉干扰。
- 品牌蓝表示主要动作、选中状态和连接就绪。
- 珊瑚色仅用于接管、远程控制激活和需要注意的信号状态，不与危险红色混用。
- 视频区域之外的表面最多使用三层深色，避免无限叠加半透明面板。
- 错误、警告和连接状态必须同时提供图标与文字。
- 控件、提示和焦点环满足WCAG AA；视频内容本身不参与界面对比度承诺。

## Typography

Viewer使用紧凑但不微小的字体。普通控件最小13px，主要状态14px，连接错误标题16px。技术诊断使用等宽字体，但默认收起。

远端网页标题允许单行截断并提供完整提示；Session名称不得覆盖连接状态。按钮优先使用图标加可访问标签，不能只依靠tooltip解释关键动作。

## Layout

视频按远端宽高比完整显示，默认不裁剪。多余区域使用`video-placeholder`，输入坐标只映射到实际视频内容框。

- 顶部导航条包含后退、前进、刷新、地址和本机打开状态。
- 底部或浮动控制条包含连接、音量、画质、文件、剪贴板、全屏和诊断。
- 窄屏时将次要动作折叠进“更多”，但导航、恢复连接和退出全屏始终可达。
- 全屏仍保留移至边缘可唤出的控制条。
- 嵌入模式通过CSS Custom Properties调整外观，不能让Embedder改坏必要焦点和遮罩层级。

## Elevation & Depth

浮动控制条使用半透明深色表面和轻微背景模糊；不支持模糊时退化为不透明`surface`。Notice、确认框和菜单比控制条高一层。阴影只用于区分视频与浮层，不制造发光边框。

连接中断、接管和暂停遮罩覆盖视频输入区域，但不遮挡宿主应用自己的页面导航。Web Component内部z-index使用有限层级，不使用接近整数上限的全局值。

## Shapes

控制条和Notice使用11px圆角，图标按钮7px。点击目标至少32×32px，触摸模式至少44×44px。焦点环位于组件外边缘并保留2px间距。

图标使用统一线性风格。连接、暂停、失焦、静音、本机打开和结束Session必须使用不同图形。Spinner不能替代说明性状态。

## Components

- **Viewport:** 保持宽高比、显示加载骨架、维护确认后的坐标变换，并在不可输入时阻止指针事件。
- **Navigation bar:** 地址输入只提交顶层导航；被策略拒绝时恢复Server确认URL并显示原因。
- **Control bar:** 默认在输入活动或鼠标靠近边缘时出现，闲置后淡出但保留键盘访问。
- **Connection indicator:** 简洁展示连接中、直连、TURN、重连、暂停和失败；详细ICE信息位于诊断面板。
- **Pause overlay:** 明确说明页面仍在远端运行，点击恢复媒体和输入。
- **Takeover dialog:** 显示将断开另一Viewer，要求明确确认。
- **Local-open dialog:** 展示目标origin和必要的登录态限制，不默认打开。
- **File tray:** 显示传输进度、大小、失败原因、领取和过期时间。
- **Notice stack:** 纯文本、限量堆叠；确认类Notice一次只激活一个。
- **Diagnostics drawer:** 展示分辨率、FPS、码率、RTT、丢包、codec、ICE route和发送端限制原因。

## Do's and Don'ts

**Do**

- 让用户始终知道当前输入是否会作用于远端。
- 在暂停、断线和重连时保留页面上下文与明确下一步。
- 对策略拒绝、权限缺失和网络错误使用不同文案。
- 使用Server确认状态更新控件，不做虚假的乐观成功。
- 为所有图标按钮提供`aria-label`、键盘焦点和tooltip。

**Don't**

- 不在视频上持续覆盖大面积工具栏或品牌水印。
- 不自动读取或同步本机剪贴板。
- 不在没有用户确认时本机打开远端URL。
- 不允许暂停状态继续发送盲输入。
- 不把TURN路径显示成故障；它是正常回退。
- 不让Embedder只能通过iframe使用Viewer。


## Retained window selection

Negotiated maintenance-style sessions add a compact second toolbar row for the remote window
selector and a child-close action. Use native keyboard-accessible select behavior, distinguish the
main window from children, and render remote titles as text. At narrow widths the row keeps the
selector and close control visible without horizontal scrolling. Announce selection progress and
disable target-dependent controls until the server confirms the selected source. The main-window
close action remains the existing Session-end flow.


## Automatic and custom quality

With both `advancedQuality` and `qualityControl` negotiated, the quality selector includes Auto,
Data saver, Balanced, High and Custom. A separate adjustment action reopens the current custom
settings. Without advanced negotiation, retain the three existing presets. Hide quality controls
when quality authorization is absent.

The custom dialog uses labeled numeric fields for maximum kbps (100–20000, step 0.001, matching integer bits/s), FPS (1–60,
integer), and downscale factor (1–4). Explain that Session policy may lower these limits and that
factor 2 halves both dimensions. Support keyboard submission, Escape/cancel, focus containment
and restoration, inline validation, pending state, and retry after failure in both locales. Keep the
form usable in a narrow viewport without overflowing the Viewer.

Selection and the accessible applied-settings description follow sender acknowledgement. Show the
confirmed encoding ceilings, including downscale, separately from measured diagnostics. An automatic
adjustment updates the applied description while the selected mode remains Auto. A failed request
preserves the last acknowledged state and an editable draft; it must not look like a successful
change. `quality-configuration-change` gives an embedding application the same confirmed state.
