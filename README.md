# Viridian Leaf

A free, open-source PDF viewer and editor for Windows.

**No bloatware. No subscriptions. No ads. Just PDFs.**

Built with [Tauri](https://tauri.app) + [React](https://react.dev) + [PDF.js](https://mozilla.github.io/pdf.js/)

Developed by **Viridian Intelligence Ltd. UK**

## Features

- **PDF Viewer** - Fast rendering with smooth zoom and scroll
- **Page Navigation** - Thumbnail sidebar, keyboard shortcuts, page jump
- **Zoom Controls** - Fit to width, custom zoom levels (Ctrl+scroll)
- **Annotations** - Highlights, text boxes, freehand drawing, signatures
- **Redaction** - Black out sensitive information
- **Export to Images** - PNG, JPEG export of any page
- **PDF Merging** - Combine multiple PDFs into one
- **Dark Theme** - Modern, easy on the eyes interface
- **File Association** - Double-click PDFs to open directly
- **Lightweight** - ~10MB installer (vs 150MB+ for Electron apps)
- **Native Performance** - Rust backend, minimal resource usage

## Installation (Windows)

### Easy Install (Recommended)

1. Go to the [Releases](https://github.com/Perspiqua/Viridian-Leaf/releases) page
2. Download **`Viridian Leaf_x.x.x_x64-setup.exe`** (the NSIS installer)
3. Run the downloaded file
4. If Windows SmartScreen appears, click **"More info"** then **"Run anyway"** (the app is unsigned but safe)
5. Follow the installer prompts
6. Done! Launch from Start Menu or double-click any PDF

### To Uninstall

Go to **Windows Settings** > **Apps** > **Installed apps** > Find "Viridian Leaf" > **Uninstall**

### Set as Default PDF Viewer

1. Right-click any PDF file
2. Select **"Open with"** > **"Choose another app"**
3. Select **"Viridian Leaf"**
4. Check **"Always use this app to open .pdf files"**
5. Click **OK**

Now all PDFs will open in Viridian Leaf when double-clicked!

---

## Build from Source (Advanced)

Only needed if you want to modify the code or build for other platforms.

**Prerequisites:**
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install)
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (Windows)

```bash
# Clone the repository
git clone https://github.com/Perspiqua/Viridian-Leaf.git
cd Viridian-Leaf

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build installer for production
npm run tauri build
```

The installers will be created in `src-tauri/target/release/bundle/`:
- `nsis/` - Windows Setup EXE (recommended)
- `msi/` - Windows Installer MSI

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+O | Open PDF |
| Ctrl+S | Save PDF |
| Ctrl+E | Export to Image |
| Ctrl++ | Zoom In |
| Ctrl+- | Zoom Out |
| Left/Right | Previous/Next Page |
| Home/End | First/Last Page |
| Ctrl+Scroll | Zoom |

## Tech Stack

- **Frontend:** React 19 + TypeScript + Vite
- **Backend:** Rust + Tauri 2.0
- **PDF Rendering:** PDF.js (Mozilla)
- **PDF Editing:** pdf-lib
- **Styling:** CSS (dark theme)

## License

MIT License - see [LICENSE](LICENSE)

Copyright (c) 2026 Viridian Intelligence Ltd. UK

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and feature requests, please use the [GitHub Issues](https://github.com/Perspiqua/Viridian-Leaf/issues) page.

---

Made with care by [Viridian Intelligence Ltd. UK](https://viridian-intelligence.co.uk)
