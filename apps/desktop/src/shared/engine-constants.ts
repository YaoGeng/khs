/**
 * 引擎侧单一来源常量（m1-insight-plan todo 7 编排项⑥：前序评审要求——组合根注入
 * 单一来源，调用方不重复写死 ENGINE_DSL_VERSION）。
 *
 * adapter-loader 包内的同名常量是包自描述值；桌面组合根以本文件为唯一注入源，
 * loadAdapterPackage({ engineVersion }) 一律从这里取值（main/collect-binding.ts）。
 */
export const ENGINE_DSL_VERSION = '1.0.0';
