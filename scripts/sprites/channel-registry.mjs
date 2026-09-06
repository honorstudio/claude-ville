import {
    MATERIAL_CHANNELS,
    MATERIAL_SIDECAR_FIELDS,
    companionPathFor,
} from '../../claudeville/src/presentation/character-mode/MaterialRegistry.js';

export const MATERIAL_CONTRACT_VERSION = 1;

// The manifest contract mirrors the runtime registry. Tooling reads the
// manifest declaration when it needs to enumerate channels, while this
// registry remains the fallback for manifests without a material contract.
export function channelsForManifest(manifest) {
    const declared = manifest?.materialContract?.channels;
    return Array.isArray(declared) && declared.length
        ? [...declared]
        : [...MATERIAL_CHANNELS];
}

export function companionChannels(channels = MATERIAL_CHANNELS) {
    const primary = channels[0];
    return channels.filter((channel) => channel !== primary);
}

export function channelContractMatchesRegistry(channels) {
    return Array.isArray(channels)
        && channels.length === MATERIAL_CHANNELS.length
        && channels.every((channel, index) => channel === MATERIAL_CHANNELS[index]);
}

export function sidecarFieldFor(channel) {
    return MATERIAL_SIDECAR_FIELDS[channel] || `${channel}Sidecar`;
}

export function companionPathForChannel(entry, channel, albedoPath) {
    const declaration = entry?.[sidecarFieldFor(channel)] ?? entry?.sidecars?.[channel];
    if (typeof declaration === 'string') return declaration;
    if (declaration === true && albedoPath) {
        return String(albedoPath).replace(/\.png(?=($|\?))/, `.${channel}.png`);
    }
    return companionPathFor(entry, channel, albedoPath);
}
