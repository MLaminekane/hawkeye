import { describe, it, expect } from 'vitest';
import { detectPackageManager, isInstallCommand } from './supply-chain.js';

describe('Supply Chain Audit', () => {
  describe('detectPackageManager', () => {
    it('detects npm commands', () => {
      expect(detectPackageManager('npm install')).toBe('npm');
      expect(detectPackageManager('npm i express')).toBe('npm');
      expect(detectPackageManager('npm ci')).toBe('npm');
      expect(detectPackageManager('npx create-react-app')).toBe('npm');
    });

    it('detects pnpm commands', () => {
      expect(detectPackageManager('pnpm install')).toBe('pnpm');
      expect(detectPackageManager('pnpm add express')).toBe('pnpm');
    });

    it('detects yarn commands', () => {
      expect(detectPackageManager('yarn install')).toBe('yarn');
      expect(detectPackageManager('yarn add express')).toBe('yarn');
    });

    it('detects bun commands', () => {
      expect(detectPackageManager('bun install')).toBe('bun');
      expect(detectPackageManager('bun add express')).toBe('bun');
    });

    it('returns null for non-package-manager commands', () => {
      expect(detectPackageManager('git status')).toBeNull();
      expect(detectPackageManager('curl https://example.com')).toBeNull();
      expect(detectPackageManager('echo hello')).toBeNull();
    });
  });

  describe('isInstallCommand', () => {
    it('identifies npm install variants', () => {
      expect(isInstallCommand('npm install')).toBe(true);
      expect(isInstallCommand('npm i')).toBe(true);
      expect(isInstallCommand('npm ci')).toBe(true);
      expect(isInstallCommand('npm install express')).toBe(true);
      expect(isInstallCommand('npm i --save-dev typescript')).toBe(true);
      expect(isInstallCommand('npm add lodash')).toBe(true);
    });

    it('identifies pnpm install variants', () => {
      expect(isInstallCommand('pnpm install')).toBe(true);
      expect(isInstallCommand('pnpm i')).toBe(true);
      expect(isInstallCommand('pnpm add express')).toBe(true);
    });

    it('identifies yarn install variants', () => {
      expect(isInstallCommand('yarn install')).toBe(true);
      expect(isInstallCommand('yarn add express')).toBe(true);
    });

    it('identifies bun install variants', () => {
      expect(isInstallCommand('bun install')).toBe(true);
      expect(isInstallCommand('bun i')).toBe(true);
      expect(isInstallCommand('bun add express')).toBe(true);
    });

    it('rejects non-install commands', () => {
      expect(isInstallCommand('npm run build')).toBe(false);
      expect(isInstallCommand('npm test')).toBe(false);
      expect(isInstallCommand('npm publish')).toBe(false);
      expect(isInstallCommand('pnpm build')).toBe(false);
      expect(isInstallCommand('yarn test')).toBe(false);
    });
  });
});
