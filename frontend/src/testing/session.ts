import { Me } from '../app/core/http/auth-api';

/** A signed-in user as `GET /api/auth/me` returns it (identity.md, I1 and I2). */
export const ANA: Me = {
  id: '0199f0b4-0000-7000-8000-000000000001',
  kind: 'user',
  username: 'ana',
  displayName: 'Ana Souza',
  isAdmin: false,
  mustChangePassword: false,
  canModel: false,
  groups: [{ id: '0199f0b4-0000-7000-8000-0000000000aa', name: 'Comercial' }],
};
