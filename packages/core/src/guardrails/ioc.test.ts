import { describe, it, expect } from 'vitest';
import {
  loadIocDatabase,
  matchPackage,
  matchDomain,
  matchHash,
  matchAll,
  iocStats,
} from './ioc.js';

describe('IOC Database', () => {
  describe('loadIocDatabase', () => {
    it('loads built-in IOCs', () => {
      const db = loadIocDatabase('/tmp/nonexistent-hawkeye-dir');
      expect(db.packages.length).toBeGreaterThan(0);
      expect(db.domains.length).toBeGreaterThan(0);
    });

    it('includes axios compromise', () => {
      const db = loadIocDatabase('/tmp/nonexistent-hawkeye-dir');
      const axios = db.packages.find((p) => p.name === 'axios');
      expect(axios).toBeDefined();
      expect(axios!.versions).toContain('1.14.1');
      expect(axios!.versions).toContain('0.30.4');
      expect(axios!.severity).toBe('critical');
    });

    it('includes event-stream compromise', () => {
      const db = loadIocDatabase('/tmp/nonexistent-hawkeye-dir');
      const es = db.packages.find((p) => p.name === 'event-stream');
      expect(es).toBeDefined();
      expect(es!.versions).toContain('3.3.6');
    });
  });

  describe('matchPackage', () => {
    const db = loadIocDatabase('/tmp/nonexistent-hawkeye-dir');

    it('matches axios@1.14.1', () => {
      const match = matchPackage('axios', '1.14.1', db);
      expect(match).not.toBeNull();
      expect(match!.severity).toBe('critical');
      expect(match!.indicator).toBe('axios@1.14.1');
      expect(match!.description).toContain('RAT');
    });

    it('matches axios@0.30.4', () => {
      const match = matchPackage('axios', '0.30.4', db);
      expect(match).not.toBeNull();
      expect(match!.severity).toBe('critical');
    });

    it('does not match clean versions', () => {
      expect(matchPackage('axios', '1.7.9', db)).toBeNull();
      expect(matchPackage('axios', '1.14.0', db)).toBeNull();
      expect(matchPackage('express', '4.21.0', db)).toBeNull();
    });

    it('matches ua-parser-js compromised versions', () => {
      expect(matchPackage('ua-parser-js', '0.7.29', db)).not.toBeNull();
      expect(matchPackage('ua-parser-js', '1.0.0', db)).not.toBeNull();
    });

    it('matches node-ipc protestware', () => {
      expect(matchPackage('node-ipc', '10.1.1', db)).not.toBeNull();
      expect(matchPackage('node-ipc', '10.1.3', db)).not.toBeNull();
    });
  });

  describe('matchDomain', () => {
    const db = loadIocDatabase('/tmp/nonexistent-hawkeye-dir');

    it('matches known C2 IPs', () => {
      const match = matchDomain('159.100.13.190', db);
      expect(match).not.toBeNull();
      expect(match!.type).toBe('domain');
      expect(match!.severity).toBe('critical');
    });

    it('does not match safe domains', () => {
      expect(matchDomain('registry.npmjs.org', db)).toBeNull();
      expect(matchDomain('github.com', db)).toBeNull();
      expect(matchDomain('127.0.0.1', db)).toBeNull();
    });
  });

  describe('matchHash', () => {
    const db = loadIocDatabase('/tmp/nonexistent-hawkeye-dir');

    it('matches known bad hashes', () => {
      const match = matchHash('placeholder_axios_1_14_1_tarball_hash', db);
      expect(match).not.toBeNull();
      expect(match!.severity).toBe('critical');
    });

    it('does not match random hashes', () => {
      expect(matchHash('abc123def456', db)).toBeNull();
    });
  });

  describe('matchAll', () => {
    const db = loadIocDatabase('/tmp/nonexistent-hawkeye-dir');

    it('finds multiple IOC types at once', () => {
      const matches = matchAll(db, {
        packages: [
          { name: 'axios', version: '1.14.1' },
          { name: 'express', version: '4.21.0' },
        ],
        domains: ['159.100.13.190', 'github.com'],
        hashes: ['placeholder_axios_1_14_1_tarball_hash', 'clean_hash'],
      });

      expect(matches.length).toBe(3); // axios + domain + hash
      expect(matches.some((m) => m.type === 'package')).toBe(true);
      expect(matches.some((m) => m.type === 'domain')).toBe(true);
      expect(matches.some((m) => m.type === 'hash')).toBe(true);
    });

    it('returns empty for clean inputs', () => {
      const matches = matchAll(db, {
        packages: [{ name: 'express', version: '4.21.0' }],
        domains: ['github.com'],
      });
      expect(matches).toHaveLength(0);
    });
  });

  describe('iocStats', () => {
    it('returns correct stats', () => {
      const db = loadIocDatabase('/tmp/nonexistent-hawkeye-dir');
      const stats = iocStats(db);
      expect(stats.totalPackages).toBeGreaterThan(5);
      expect(stats.totalVersions).toBeGreaterThan(10);
      expect(stats.totalDomains).toBeGreaterThan(0);
      expect(stats.critical).toBeGreaterThan(0);
    });
  });
});
