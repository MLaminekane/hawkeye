import { describe, it, expect } from 'vitest';
import { analyzeEgress, type EgressConnection } from './egress-monitor.js';

function makeConn(overrides: Partial<EgressConnection> = {}): EgressConnection {
  return {
    pid: 1234,
    process: 'node',
    remoteHost: '93.184.216.34',
    remotePort: 443,
    protocol: 'TCP',
    state: 'ESTABLISHED',
    ...overrides,
  };
}

describe('Egress Monitor', () => {
  describe('analyzeEgress', () => {
    it('flags connections to unknown hosts', () => {
      const connections = [
        makeConn({ remoteHost: '185.199.108.154', process: 'curl' }),
      ];
      const result = analyzeEgress(connections);
      expect(result.suspicious).toHaveLength(1);
      expect(result.suspicious[0].remoteHost).toBe('185.199.108.154');
    });

    it('allows localhost connections', () => {
      const connections = [
        makeConn({ remoteHost: '127.0.0.1', remotePort: 4242 }),
        makeConn({ remoteHost: '::1', remotePort: 8080 }),
        makeConn({ remoteHost: 'localhost', remotePort: 3000 }),
      ];
      const result = analyzeEgress(connections);
      expect(result.suspicious).toHaveLength(0);
    });

    it('allows private IP ranges', () => {
      const connections = [
        makeConn({ remoteHost: '10.0.0.1' }),
        makeConn({ remoteHost: '192.168.1.100' }),
        makeConn({ remoteHost: '172.16.0.5' }),
      ];
      const result = analyzeEgress(connections);
      expect(result.suspicious).toHaveLength(0);
    });

    it('allows known safe hosts', () => {
      const connections = [
        makeConn({ remoteHost: 'registry.npmjs.org' }),
        makeConn({ remoteHost: 'api.github.com' }),
        makeConn({ remoteHost: 'api.anthropic.com' }),
      ];
      const result = analyzeEgress(connections);
      expect(result.suspicious).toHaveLength(0);
    });

    it('allows user-specified hosts', () => {
      const connections = [
        makeConn({ remoteHost: 'internal.mycompany.com' }),
      ];
      const result = analyzeEgress(connections, ['internal.mycompany.com']);
      expect(result.suspicious).toHaveLength(0);
    });

    it('allows subdomains of allowed hosts', () => {
      const connections = [
        makeConn({ remoteHost: 'api.internal.mycompany.com' }),
      ];
      const result = analyzeEgress(connections, ['mycompany.com']);
      expect(result.suspicious).toHaveLength(0);
    });

    it('flags suspicious connections in summary', () => {
      const connections = [
        makeConn({ remoteHost: '45.33.32.156', process: 'backdoor', pid: 666 }),
      ];
      const result = analyzeEgress(connections);
      expect(result.suspicious).toHaveLength(1);
      expect(result.summary).toContain('suspicious');
      expect(result.summary).toContain('backdoor');
      expect(result.summary).toContain('45.33.32.156');
    });

    it('reports all clear when no suspicious connections', () => {
      const connections = [
        makeConn({ remoteHost: '127.0.0.1' }),
        makeConn({ remoteHost: 'registry.npmjs.org' }),
      ];
      const result = analyzeEgress(connections);
      expect(result.suspicious).toHaveLength(0);
      expect(result.summary).toContain('all clear');
    });

    it('handles empty connection list', () => {
      const result = analyzeEgress([]);
      expect(result.suspicious).toHaveLength(0);
      expect(result.connections).toHaveLength(0);
    });

    it('correctly mixes safe and suspicious connections', () => {
      const connections = [
        makeConn({ remoteHost: '127.0.0.1' }),
        makeConn({ remoteHost: 'registry.npmjs.org' }),
        makeConn({ remoteHost: '185.100.87.174', process: 'unknown-rat' }),
        makeConn({ remoteHost: 'api.github.com' }),
      ];
      const result = analyzeEgress(connections);
      expect(result.connections).toHaveLength(4);
      expect(result.suspicious).toHaveLength(1);
      expect(result.suspicious[0].process).toBe('unknown-rat');
    });
  });
});
