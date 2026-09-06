import { propDepthDrawable } from './DrawablePass.js';

export function buildStaticPropDrawables(...spriteGroups) {
    const drawables = [];
    for (const group of spriteGroups) {
        for (const sprite of group || []) {
            if (sprite.splitForOcclusion) {
                drawables.push(propDepthDrawable(sprite, 'back'));
                drawables.push(propDepthDrawable(sprite, 'front'));
            } else {
                drawables.push(propDepthDrawable(sprite));
            }
        }
    }
    return drawables;
}
