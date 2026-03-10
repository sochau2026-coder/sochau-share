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
      credential: 'a4dc038aa26d6469847ba0b32ab752fb82f83d23a572e4e19d2334f3dfb40691',
    },
    {
      urls: 'turn:share.sochau.cloud:3478?transport=tcp',
      username: 'sochau',
      credential: 'a4dc038aa26d6469847ba0b32ab752fb82f83d23a572e4e19d2334f3dfb40691',
    },
    {
      urls: 'turns:share.sochau.cloud:5349',
      username: 'sochau',
      credential: 'a4dc038aa26d6469847ba0b32ab752fb82f83d23a572e4e19d2334f3dfb40691',
    },
    {
      urls: 'turns:share.sochau.cloud:5349?transport=tcp',
      username: 'sochau',
      credential: 'a4dc038aa26d6469847ba0b32ab752fb82f83d23a572e4e19d2334f3dfb40691',
    },
  ],
};

export { ICE_SERVERS };
