import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 10 },
    { duration: '20s', target: 50 },
    { duration: '20s', target: 100 },
    { duration: '10s', target: 0 },
  ],

  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
  },
};

export default function () {
  const res = http.get(
    'https://jordan-gas-api-production.up.railway.app/api/v2/zones',
    {
      timeout: '5s',
      tags: {
        endpoint: 'zones',
      },
    }
  );

  check(res, {
    'HTTP 200': (r) => r.status === 200,
    'response under 1s': (r) => r.timings.duration < 1000,
  });
}