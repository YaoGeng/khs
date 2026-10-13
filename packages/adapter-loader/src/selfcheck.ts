import { parseHTML } from 'linkedom';
import type { SelfcheckFeature, SelfcheckRunner } from './loader.js';

/**
 * 默认自检 DOM 匹配器：linkedom 纯 JS DOM，在 fixture 无害页上回放选择器
 * （02:390「自检用例在无害页面回放」；不碰真实线上页面）。linkedom 为 devDependency。
 */
export function createLinkedomSelfcheckRunner(): SelfcheckRunner {
  return (html, features) => {
    const { document } = parseHTML(html);
    const failed: SelfcheckFeature[] = [];
    for (const feature of features) {
      const count = document.querySelectorAll(feature.selector).length;
      if (count < feature.minCount) {
        failed.push(feature);
      }
    }
    return { passed: failed.length === 0, failed };
  };
}
