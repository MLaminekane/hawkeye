import { describe, it, expect } from 'vitest';
import { parseInstallCommand, scanPackages } from './package-scanner.js';
import { loadIocDatabase } from './ioc.js';

describe('Package Scanner', () => {
  describe('parseInstallCommand', () => {
    it('parses npm install with specific packages', () => {
      const targets = parseInstallCommand('npm install axios@1.14.1');
      expect(targets).toHaveLength(1);
      expect(targets[0].name).toBe('axios');
      expect(targets[0].version).toBe('1.14.1');
      expect(targets[0].source).toBe('command');
    });

    it('parses npm install with multiple packages', () => {
      const targets = parseInstallCommand('npm install axios@1.14.1 lodash@4.17.21');
      expect(targets).toHaveLength(2);
      expect(targets[0].name).toBe('axios');
      expect(targets[1].name).toBe('lodash');
    });

    it('parses pnpm add', () => {
      const targets = parseInstallCommand('pnpm add express@4.21.0');
      expect(targets).toHaveLength(1);
      expect(targets[0].name).toBe('express');
      expect(targets[0].version).toBe('4.21.0');
    });

    it('parses yarn add', () => {
      const targets = parseInstallCommand('yarn add react@18.3.1');
      expect(targets).toHaveLength(1);
      expect(targets[0].name).toBe('react');
    });

    it('handles packages without version as latest', () => {
      const targets = parseInstallCommand('npm install axios');
      expect(targets).toHaveLength(1);
      expect(targets[0].name).toBe('axios');
      expect(targets[0].version).toBe('latest');
    });

    it('skips flags', () => {
      const targets = parseInstallCommand('npm install --save-dev typescript@5.7.0');
      expect(targets).toHaveLength(1);
      expect(targets[0].name).toBe('typescript');
    });

    it('handles scoped packages', () => {
      const targets = parseInstallCommand('npm install @types/node@22.0.0');
      expect(targets).toHaveLength(1);
      expect(targets[0].name).toBe('@types/node');
      expect(targets[0].version).toBe('22.0.0');
    });

    it('returns empty for install without packages', () => {
      const targets = parseInstallCommand('npm install');
      expect(targets).toHaveLength(0);
    });

    it('returns empty for npm ci', () => {
      const targets = parseInstallCommand('npm ci');
      expect(targets).toHaveLength(0);
    });
  });

  describe('scanPackages', () => {
    it('detects compromised packages from command targets', () => {
      const db = loadIocDatabase('/tmp/nonexistent-hawkeye-dir');
      const targets = parseInstallCommand('npm install axios@1.14.1');
      const result = scanPackages('/tmp/nonexistent-dir', db, targets);

      expect(result.threats.length).toBeGreaterThan(0);
      expect(result.threats[0].severity).toBe('critical');
      expect(result.threats[0].indicator).toContain('axios@1.14.1');
      expect(result.summary).toContain('THREAT');
    });

    it('passes for clean packages', () => {
      const db = loadIocDatabase('/tmp/nonexistent-hawkeye-dir');
      const targets = parseInstallCommand('npm install express@4.21.0');
      const result = scanPackages('/tmp/nonexistent-dir', db, targets);

      expect(result.threats).toHaveLength(0);
      expect(result.summary).toContain('no known threats');
    });

    it('warns for packages with known compromised versions (latest)', () => {
      const db = loadIocDatabase('/tmp/nonexistent-hawkeye-dir');
      const targets = parseInstallCommand('npm install axios');
      const result = scanPackages('/tmp/nonexistent-dir', db, targets);

      // Should warn because axios has compromised versions
      expect(result.threats.length).toBeGreaterThan(0);
      expect(result.threats[0].indicator).toContain('latest');
    });

    it('detects multiple threats at once', () => {
      const db = loadIocDatabase('/tmp/nonexistent-hawkeye-dir');
      const targets = parseInstallCommand('npm install axios@1.14.1 ua-parser-js@0.7.29');
      const result = scanPackages('/tmp/nonexistent-dir', db, targets);

      expect(result.threats.length).toBe(2);
      expect(result.threats.every((t) => t.severity === 'critical')).toBe(true);
    });
  });
});
