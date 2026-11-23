const EPOCH = 1704067200000n;
let sequence = 0n;
let last = -1n;
const node = BigInt(512 + Math.floor(Math.random() * 512));

export function nextSnowflake(): string {
  let ms = BigInt(Date.now());
  if (ms < last) ms = last;
  if (ms === last) {
    sequence = (sequence + 1n) & 0xfffn;
    if (sequence === 0n) ms += 1n;
  } else {
    sequence = 0n;
  }
  last = ms;
  return (((ms - EPOCH) << 22n) | (node << 12n) | sequence).toString();
}
