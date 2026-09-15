# Mindmap

一款简洁的 Windows 本地思维导图应用。用键盘和鼠标整理想法，再导出 Mermaid 放进 Obsidian，无需编写代码。

A minimal, local-first mind map editor for Windows. Organize ideas with your keyboard and mouse, then export Mermaid for Obsidian—without writing code.

## 功能 / Features

- 从左向右展开，同层节点对齐；细框、曲线箭头与深浅色主题。
  Left-to-right layout, aligned columns, thin borders, curved arrows, and light/dark themes.
- 快捷键编辑、分支拖动、折叠、搜索、撤销与重做。
  Keyboard editing, branch dragging, folding, search, undo, and redo.
- 节点之间可添加虚线联系，拖动曲线、输入横向联系文字。
  Connect nodes with adjustable dashed curves and horizontal relationship labels.
- 粘贴图片、按比例缩放、调整整列宽度；支持跨导图复制节点和图片。
  Paste and resize images, adjust column widths, and copy nodes or images between maps.
- 文件夹导图库与大纲侧栏，可拖动排序、移动和重命名。
  A folder-based library and outline, with drag-to-reorder, move, and rename.

`Tab` 添加子节点 / add a child · `Enter` 添加同级节点 / add a sibling · `Shift + Enter` 换行 / line break.
更多快捷键见应用文件菜单。 More shortcuts are available in the app's File menu.

## 安装 / Install

准备 Windows x64、Node.js 24 和 npm。克隆或下载本仓库后，在仓库目录打开 PowerShell：

On Windows x64, install Node.js 24 and npm. Clone or download this repository, then open PowerShell in its directory:

```powershell
npm ci
npm run build
npm run package
& .\scripts\install-local.ps1 -Destination "$env:LOCALAPPDATA\Programs\Mindmap"
```

安装脚本会创建桌面快捷方式。可将 `-Destination` 改为自己选择的独立可写目录；更新前先关闭应用，已有导图会保留。

The installer creates a desktop shortcut. Change `-Destination` to a dedicated writable folder of your choice. Close the app before updating; existing maps are preserved.

也可以把本仓库交给 Codex，并复制这段提示：

> 请从当前仓库在我的 Windows 电脑上构建并安装 Mindmap，创建桌面快捷方式，使用独立、可写的本地目录存放应用和导图。保留已有导图，不上传任何个人数据。

Or open this repository in Codex and use this prompt:

> Build and install Mindmap from this repository on my Windows computer. Create a desktop shortcut and use a dedicated writable local directory for the app and maps. Preserve existing maps and do not upload any personal data.

## 本地文件 / Local files

无需账户，应用可离线使用。导图自动保存为 `.mindmap` 文件，文字、结构、图片、列宽和联系保存在同一个文件中。

No account is required, and the app works offline. Maps autosave as self-contained `.mindmap` files containing text, structure, images, column widths, and relationships.

本仓库不包含个人导图。 This repository does not include personal maps.

- 打包版：`导图/` 和 `.mindmap/` 位于应用旁，请放在可写入的文件夹中。
  Packaged app: maps live in `导图/`, with settings and recovery data in `.mindmap/`, beside the executable. Use a writable location.
- 开发版：数据默认位于项目的 `local-data/`。可用 `INKMAP_HOME` 指定其他数据目录。
  Development: data defaults to `local-data/` in the project. Set `INKMAP_HOME` to use another data directory.
- **另存为只创建副本**，后续编辑仍保存到原工作导图；打开库外文件会导入独立副本，保留外部原件。
  **Save As creates a copy**; later edits still save to the working map. Opening an external file imports a separate copy and leaves the original untouched.

## 导出 / Exports

| 格式 / Format | 内容 / Content |
| --- | --- |
| Mermaid / Markdown | 全部文字、树结构和虚线联系，包含折叠分支；不含图片和手调曲线形状。All text, structure, and dashed relationships, including folded branches; images and custom curve shapes are omitted. |
| PDF | 当前展开的完整导图，含图片，白底；不受画布缩放或平移影响。The complete expanded map with images, on white paper, independent of canvas zoom or pan. |

Mermaid 使用 `flowchart LR`，不指定字体；Obsidian 会按自身主题和 Mermaid 配置重新布局。

Mermaid exports use `flowchart LR` without setting a font. Obsidian renders them using its theme and Mermaid configuration, so spacing and line breaks may differ.

## 开发 / Development

技术栈为 Electron、React、TypeScript。安装依赖后可直接运行源码：

Built with Electron, React, and TypeScript. After installing dependencies, run from source:

```sh
npm run build
npm start
```

```sh
npm test                # 核心与存储测试 / Core and storage tests
npm run test:desktop    # 隔离桌面测试 / Isolated desktop tests
```

其他交互测试见 `package.json` 中的 `test:*` 脚本。
Additional interaction suites are available through the `test:*` scripts in `package.json`.

## 字体 / Fonts

在文件菜单的“字体”中切换衬线体或 NeverMind，整款应用同步切换并记住选择。PDF 保留所选字体，Mermaid 字体仍由 Obsidian 决定。

Choose the original serif fonts or NeverMind in File → Font. The choice applies across the app and persists. PDF keeps the selected font; Mermaid follows Obsidian's font settings.

英文使用随附的 URW Classico；中文优先使用本机安装的 PMingLiU，缺少时回退到系统衬线字体。PMingLiU 不随应用分发。

URW Classico is bundled for Latin text. Chinese text uses locally installed PMingLiU when available, with a system serif fallback. PMingLiU is not distributed with the app.

URW Classico © 2000, 2013 (URW)++ Design & Development。随附字体说明仅允许非商业分发；字体适用其自身许可，不应视为应用源码许可的一部分。

URW Classico © 2000, 2013 (URW)++ Design & Development. Its upstream notice permits non-commercial distribution only. The fonts retain their own license, separate from application code.

详见 / See [font notice](assets/fonts/classico-README.txt) and [Aladdin Free Public License](assets/fonts/AFPL.htm).

NeverMind 由 Xmind 设计，以 SIL OFL 1.1 许可随附；中文搭配本机微软雅黑或系统无衬线字体。详见 [许可](assets/fonts/NeverMind-LICENSE.txt) 与 [来源](assets/fonts/NeverMind-SOURCE.txt)。

NeverMind is designed by Xmind and bundled under SIL OFL 1.1. Chinese uses locally installed Microsoft YaHei or a system sans-serif fallback. See the [license](assets/fonts/NeverMind-LICENSE.txt) and [source](assets/fonts/NeverMind-SOURCE.txt).

暂不支持 Mermaid 导入或 XMind 文件。 Mermaid import and XMind files are not supported.
