const ICE_SERVERS = {
  stun: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:share.sochau.cloud:3478' },
  ],
  turn: [
    {
      urls: 'turn:share.sochau.cloud:3478',
      username: 'sochau',
      credential: 'SochauTurn2026',
    },
    {
      urls: 'turn:share.sochau.cloud:3478?transport=tcp',
      username: 'sochau',
      credential: 'SochauTurn2026',
    },
    {
      urls: 'turns:share.sochau.cloud:5349',
      username: 'sochau',
      credential: 'SochauTurn2026',
    },
    {
      urls: 'turns:share.sochau.cloud:5349?transport=tcp',
      username: 'sochau',
      credential: 'SochauTurn2026',
    },
  ],
};

export { ICE_SERVERS };
