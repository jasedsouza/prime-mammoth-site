// Adapters expose init({onMuteChange}), event(name), read(key) and write(key,value).
// Storage exceptions deliberately reach the game's existing session-memory fallback.
export const adapter = {
  async init({onMuteChange}) { onMuteChange(false); },
  event() {},
  read(key) { return localStorage.getItem(key); },
  write(key,value) { localStorage.setItem(key,value); }
};
