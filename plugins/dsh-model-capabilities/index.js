/**
 * 模型能力管理（dsh-model-capabilities）— host 半边。
 *
 * 本插件是纯客户端插件：全部数据与写入都经由出厂的远程命名空间完成
 *（remote.session.modelCatalog 读模型目录、remote.settings.describe/update
 * 读写 llm-pi-ai 设置），host 侧没有任何行为，因此这里只是一个加载器入口。
 * 浏览器实现见 ./client.js（package.json 的 dsh.client 声明）。
 *
 * 组合行（profile 的 cordis.patch.yml）：
 *   - insert:
 *       - id: model-capabilities
 *         name: ./plugins/dsh-model-capabilities/index.js
 *
 * @module dsh-model-capabilities
 */

export const name = 'model-capabilities';

/** Host plugin body — no host-side behavior; the browser half owns everything. */
export function apply() {}
