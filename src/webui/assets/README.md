# 无界世界 SVG

为 YesImBot World 绘制的矢量资源：开放的边界、分支路径、正在展开的地貌。主色为深海蓝、薄荷青、地平线琥珀与淡紫。所有插图都使用 SVG 路径绘制，不依赖外部图片或字体。

- `open-world-mark.svg`：品牌标记，三条路径越过尚未闭合的边界。
- `unfolding-worlds.svg`：总览插图，沙洲、河流与棱晶世界由同一片开放地平线连接；适合深色背景。
- `world-seed.svg`：空状态，等待生长的世界种子；继承文字颜色。
- `world-paths.svg`：侧栏小图标，仍向外延伸的轨迹。

网页使用 `client/world-art.js` 内联这些资源，避免额外请求，并为每个实例生成独立的标题与渐变 ID。以上 SVG 是可直接打开、用于设计预览的导出副本。修改插图时先更新模块，再从项目根目录同步导出：

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(fs.readFileSync('src/webui/client/world-art.js', 'utf8'), context);
for (const [name, file] of [
  ['logo', 'open-world-mark.svg'],
  ['hero', 'unfolding-worlds.svg'],
  ['empty', 'world-seed.svg'],
  ['orbit', 'world-paths.svg'],
]) fs.writeFileSync('src/webui/assets/' + file, context.worldArt[name]() + '\n');
JS
```
