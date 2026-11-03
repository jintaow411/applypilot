import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion: 3,
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'ApplyPilot · AI 求职表单助手',
    description: '抽取招聘表单字段，核对建议值，一键填入；陌生页面可上报给本地适配服务。',
    permissions: ['storage', 'activeTab', 'scripting', 'sidePanel'],
    // 工具栏图标：无 popup，点击由 background 的 openPanelOnActionClick 接管为开/关侧边栏
    // 图标源文件 public/icon/logo.svg，PNG 由同目录产物提供；WXT 也会自动把 public/icon/*.png 写进 manifest.icons
    action: {
      default_title: '打开 ApplyPilot 侧边栏',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
    host_permissions: [
      // 本地 Go 适配 / 上报服务
      'http://127.0.0.1:17880/*',
      // 用户自填的 AI 接口（OpenAI-compatible / Anthropic），跨域 fetch 需要 host 权限
      'http://*/*',
      'https://*/*',
    ],
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
