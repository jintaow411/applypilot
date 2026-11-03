### 每次使用

先启动本地服务端：

cd <clone-directory>/server

AUTO_INFO_EXTENSION_ORIGIN=chrome-extension://你的扩展ID \
./auto-info-server

如果还没有编译服务端：

cd <clone-directory>/server
go build -o auto-info-server .

检查服务是否正常：

curl http://127.0.0.1:17880/healthz

然后在浏览器中：

1. 打开 chrome://extensions
2. 点击 ApplyPilot 的“重新加载”
3. 刷新招聘页面
4. 打开扩展侧边栏
5. 点击“一键生成”
6. 检查 AI 建议
7. 点击“一键填入”
8. 人工核对后提交

### 代码更新后

cd <clone-directory>/apps/extension

npx tsc --noEmit
npx wxt build

然后到 chrome://extensions 重新加载：

apps/extension/.output/chrome-mv3/

### 开发模式

cd <clone-directory>/apps/extension
npx wxt

### 首次或服务端配置异常时

重新查看 token：

cd <clone-directory>/server
cat .token

服务端数据位置：

server/.token
server/data/auto-info.db

通常第二次使用不需要重新配置 token；只要扩展 ID 没变，直接启动服务即可。

### 一键启动服务端的简写

如果已经编译过：

cd <clone-directory>/server && \
AUTO_INFO_EXTENSION_ORIGIN=chrome-extension://你的扩展ID ./auto-info-server

注意：项目不会自动点击最终“提交申请”按钮，填充后必须人工检查并提交。
