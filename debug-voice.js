const { generateDependencyReport } = require('@discordjs/voice');
const prism = require('prism-media');

console.log('--- Discord Voice Dependency Report ---');
console.log(generateDependencyReport());

console.log('\n--- Prism Media Check ---');
try {
    const opus = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
    console.log('Prism Opus Decoder: OK');
} catch (e) {
    console.log('Prism Opus Decoder: FAILED -', e.message);
}
