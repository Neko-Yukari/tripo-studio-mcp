# 内置的 assimp 转换器

`assimpjs.cjs` + `assimpjs.wasm` 用于把 Tripo 下载下来的 GLB 转成 FBX / OBJ / STL。

## 来源

这是 [assimp](https://github.com/assimp/assimp) 通过 [assimpjs](https://github.com/kovacsv/assimpjs) 编译出来的 WebAssembly 构建，取自 Tripo Studio 网页端加载的同一份产物（`studio.tripo3d.ai/_assimp/wasm/assimpjs-meshopt-*.{js,wasm}`）。

选它的原因：Tripo 输出的 GLB 是 `gltfpack` 压过的，带 `EXT_meshopt_compression` 和 `KHR_mesh_quantization`。npm 上的 `assimpjs` 官方构建不支持这两个扩展，也不含 FBX / OBJ / STL 三个 exporter，直接转换会返回 `export_error`。这一份两者都支持。

## 替换成自建版本

想要完全属于自己的构建，按 assimp 的 CMake 选项打开对应 exporter，编译成 wasm，然后把产物放进本目录（胶水代码命名为 `assimpjs.cjs`，二进制命名为 `assimpjs.wasm`）即可；也可以用环境变量 `TRIPO_ASSIMP_DIR` 指向放在别处的目录。接口只需要满足：

```js
const factory = require('<dir>/assimpjs.cjs');
const ajs = await factory({ locateFile: () => '<dir>/assimpjs.wasm' });
const list = new ajs.FileList();
list.AddFile('model.glb', new Uint8Array(glbBytes));
const result = ajs.ConvertFileList(list, 'fbx' | 'obj' | 'stl', {}, name);
result.IsSuccess(); result.FileCount(); result.GetFile(i).GetPath(); result.GetFile(i).GetContent();
```

注意 assimp 官方的 FBX 导出仍标着 experimental，自建版本的输出质量未必与这里一致。

## 许可

- assimp：BSD-3-Clause，见 <https://github.com/assimp/assimp/blob/master/LICENSE>
- assimpjs：MIT，见 <https://github.com/kovacsv/assimpjs/blob/master/LICENSE.md>
- meshoptimizer（被编入该 wasm）：MIT，见 <https://github.com/zeux/meshoptimizer/blob/master/LICENSE.md>

再分发时请保留以上声明。
