/**
 * Appearance value-object.
 *
 * DEPRECATED FIELDS (skin, shirt, hair, hairStyle, pants, accessory, eyeStyle):
 * These fields are only consumed by the dashboard avatar's procedural fallback
 * path in the dashboard-mode `AvatarCanvas.js` (i.e. when
 * `getModelVisualIdentity(...).spriteId` is null, when the sprite PNG fails to
 * load, or on the first frame before the PNG is decoded). World mode
 * (the character-mode renderers) renders agents from sprite sheets with
 * palette-swap and does NOT read any of these fields. When the dashboard
 * fallback is retired or replaced with sprite-only rendering, these fields and
 * their color tables can be removed.
 *
 * `Appearance.hashCode` is still used as a stable per-agent hash by
 * `Agent.generateName`, `Agent.displayName`, and `App._regenerateAgentNames`.
 * Keep `hashCode` even if/when the appearance fields are removed.
 */
const SKIN_COLORS = ['#ffdbac', '#f1c27d', '#e0ac69', '#c68642', '#8d5524'];
// 1.11 — muted neutrals replace the old saturated ramp: the dashboard fallback
// gets its identity hue from the provider trim/accent (AvatarCanvas prefers
// identity.trim/accent over app.shirt), so clothing stays quiet.
const SHIRT_COLORS = ['#5f7fa6', '#a6625e', '#6a9a72', '#c2a35c', '#9579a8', '#b3805a', '#5e9a8a'];
const HAIR_COLORS = ['#2c1810', '#4a3728', '#8b6914', '#c9a96e', '#d63c3c', '#1a1a2e'];
const HAIR_STYLES = ['short', 'long', 'spiky', 'bald', 'mohawk'];
const PANTS_COLORS = ['#2d3436', '#1e3a5f', '#4a4a4a', '#2c3e50', '#1a1a2e'];
const ACCESSORIES = ['none', 'crown', 'glasses', 'headphones', 'hat'];
const EYE_STYLES = ['normal', 'happy', 'determined', 'sleepy'];

export class Appearance {
    constructor({ skin, shirt, hair, hairStyle, pants, accessory, eyeStyle }) {
        this.skin = skin;
        this.shirt = shirt;
        this.hair = hair;
        this.hairStyle = hairStyle;
        this.pants = pants;
        this.accessory = accessory;
        this.eyeStyle = eyeStyle;
    }

    static fromHash(id) {
        const hash = Appearance.hashCode(id);
        return new Appearance({
            skin: SKIN_COLORS[Math.abs(hash) % SKIN_COLORS.length],
            shirt: SHIRT_COLORS[Math.abs(hash >> 4) % SHIRT_COLORS.length],
            hair: HAIR_COLORS[Math.abs(hash >> 8) % HAIR_COLORS.length],
            hairStyle: HAIR_STYLES[Math.abs(hash >> 12) % HAIR_STYLES.length],
            pants: PANTS_COLORS[Math.abs(hash >> 16) % PANTS_COLORS.length],
            accessory: ACCESSORIES[Math.abs(hash >> 20) % ACCESSORIES.length],
            eyeStyle: EYE_STYLES[Math.abs(hash >> 24) % EYE_STYLES.length],
        });
    }

    static fromIdentityKey(identityKey) {
        return Appearance.fromHash(String(identityKey || ''));
    }

    static hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }
}
