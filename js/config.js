const CONFIG = {
  // Replace with your PieSocket API Key (or enter dynamically via app Settings)
  DEFAULT_PIESOCKET_KEY: "YOUR_PIESOCKET_API_KEY",
  DEFAULT_CLUSTER: "free.blr1",
  
  // Audio & Media Defaults
  ICE_SERVERS: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ],

  // Security Defaults
  DEFAULT_AUTO_BURN_SECONDS: 10,
  VAULT_STORAGE_KEY: "terminal_chat_vault",
  DEVICE_ID_STORAGE_KEY: "chat_device_id"
};
