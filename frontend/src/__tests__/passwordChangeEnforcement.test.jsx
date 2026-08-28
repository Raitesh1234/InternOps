import { describe, expect, test } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (relative) =>
  fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');

describe('first-login password enforcement', () => {
  test('blocks protected routes until the password is changed', () => {
    const source = read('App.jsx');
    expect(source).toContain('user?.mustChangePassword');
    expect(source).toContain("window.location.pathname !== '/profile'");
    expect(source).toContain('<Navigate to="/profile" replace />');
  });

  test('redirects temporary-password login to Profile', () => {
    const source = read('pages/Login.jsx');
    expect(source).toContain(
      "navigate(data.user?.mustChangePassword ? '/profile' : '/')"
    );
  });

  test('shows instructions and clears the local flag after success', () => {
    const source = read('pages/Profile.jsx');
    expect(source).toContain('Password change required');
    expect(source).toContain('mustChangePassword: false');
    const successBlock = source.indexOf(
      "flash('Password changed successfully')"
    );
    const clearFlag = source.indexOf('mustChangePassword: false');
    expect(successBlock).toBeGreaterThan(-1);
    expect(clearFlag).toBeGreaterThan(successBlock);
  });
});
