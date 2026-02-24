export class LRUCache {
  constructor(maxEntries = 200) {
    this.max = maxEntries;
    this.map = new Map(); // key -> value, insertion order used for LRU
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  clear() { this.map.clear(); }
}