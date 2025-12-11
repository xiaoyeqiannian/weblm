const fs = require('fs');
const path = require('path');

// 构建脚本 - 将源文件复制到正确的位置

const sourceDir = path.join(__dirname, '../src');
const distDir = path.join(__dirname, '../dist');

// 需要复制的文件映射
const filesToCopy = [
  { src: 'manifest.json', dest: 'manifest.json' },
  { src: 'background/background.js', dest: 'background/background.js' },
  { src: 'content/content.js', dest: 'content/content.js' },
  { src: 'content/content.css', dest: 'content/content.css' },
  { src: 'popup/popup.html', dest: 'popup/popup.html' },
  { src: 'popup/popup.css', dest: 'popup/popup.css' },
  { src: 'popup/popup.js', dest: 'popup/popup.js' },
  { src: 'icons', dest: 'icons' },
  { src: 'src/core', dest: 'src/core' }
];

// 递归创建目录
function mkdirSync(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// 递归复制文件夹
function copyDir(src, dest) {
  mkdirSync(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 复制单个文件
function copyFile(src, dest) {
  const destDir = path.dirname(dest);
  mkdirSync(destDir);
  fs.copyFileSync(src, dest);
}

// 主构建函数
function build() {
  console.log('开始构建...\n');
  
  // 清理 dist 目录
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true });
  }
  mkdirSync(distDir);
  
  // 复制文件
  const rootDir = path.join(__dirname, '..');
  
  for (const file of filesToCopy) {
    const srcPath = path.join(rootDir, file.src);
    const destPath = path.join(distDir, file.dest);
    
    if (fs.existsSync(srcPath)) {
      if (fs.statSync(srcPath).isDirectory()) {
        copyDir(srcPath, destPath);
        console.log(`📁 复制目录: ${file.src} -> dist/${file.dest}`);
      } else {
        copyFile(srcPath, destPath);
        console.log(`📄 复制文件: ${file.src} -> dist/${file.dest}`);
      }
    } else {
      console.warn(`⚠️ 文件不存在: ${file.src}`);
    }
  }
  
  // 合并 content script
  const contentScriptContent = `
// 核心模块
${fs.readFileSync(path.join(rootDir, 'src/core/annotation-service.js'), 'utf8')}

${fs.readFileSync(path.join(rootDir, 'src/core/auto-scroll-service.js'), 'utf8')}

${fs.readFileSync(path.join(rootDir, 'src/core/voice-service.js'), 'utf8')}

// Content Script 主逻辑
${fs.readFileSync(path.join(rootDir, 'content/content.js'), 'utf8')}
`;
  
  fs.writeFileSync(
    path.join(distDir, 'content/content.js'),
    contentScriptContent
  );
  console.log('📦 合并 content script');
  
  // 创建占位图标（如果没有的话）
  const iconSizes = [16, 32, 48, 128];
  const iconsDir = path.join(distDir, 'icons');
  mkdirSync(iconsDir);
  
  // 复制 SVG 图标
  const svgPath = path.join(rootDir, 'icons/icon.svg');
  if (fs.existsSync(svgPath)) {
    // 为每个尺寸创建一个简单的占位 PNG（实际使用时应该用真正的 PNG）
    for (const size of iconSizes) {
      const pngPath = path.join(iconsDir, `icon${size}.png`);
      // 创建一个简单的 1x1 像素 PNG 作为占位
      // 实际部署时应该用真正的图标文件
      if (!fs.existsSync(pngPath)) {
        // 创建一个最小的有效 PNG 文件
        const minimalPng = Buffer.from([
          0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG 签名
          0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR 块
          0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 像素
          0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
          0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT 块
          0x54, 0x08, 0xD7, 0x63, 0xF8, 0x67, 0xC0, 0x60,
          0x00, 0x00, 0x00, 0x83, 0x00, 0x81, 0xDC, 0x36,
          0xEB, 0x36, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, // IEND 块
          0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
        ]);
        fs.writeFileSync(pngPath, minimalPng);
        console.log(`🖼️ 创建占位图标: icon${size}.png`);
      }
    }
  }
  
  console.log('\n✅ 构建完成！');
  console.log('\n📋 使用说明:');
  console.log('1. 打开 Chrome 浏览器');
  console.log('2. 访问 chrome://extensions/');
  console.log('3. 开启"开发者模式"');
  console.log('4. 点击"加载已解压的扩展程序"');
  console.log(`5. 选择目录: ${distDir}`);
}

// 监视模式
const isWatch = process.argv.includes('--watch');

if (isWatch) {
  console.log('👀 监视模式已启动...\n');
  build();
  
  const watchDirs = [
    path.join(__dirname, '../src'),
    path.join(__dirname, '../content'),
    path.join(__dirname, '../popup'),
    path.join(__dirname, '../background')
  ];
  
  for (const dir of watchDirs) {
    if (fs.existsSync(dir)) {
      fs.watch(dir, { recursive: true }, (eventType, filename) => {
        console.log(`\n🔄 检测到变化: ${filename}`);
        build();
      });
    }
  }
} else {
  build();
}
