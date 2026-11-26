const MAHONY_KP = 0.5;
const MAHONY_KI = 0.01;

export function createMahonyState() {
  return {
    q0: 1, q1: 0, q2: 0, q3: 0,
    integralFBx: 0, integralFBy: 0, integralFBz: 0,
  };
}

export function mahonyUpdate(s, gx, gy, gz, ax, ay, az, dt) {
  let { q0, q1, q2, q3, integralFBx, integralFBy, integralFBz } = s;

  const aNorm = Math.sqrt(ax*ax + ay*ay + az*az);
  if (aNorm > 1e-6) {
    ax /= aNorm;  ay /= aNorm;  az /= aNorm;

    const vx = 2*(q1*q3 - q0*q2);
    const vy = 2*(q0*q1 + q2*q3);
    const vz = q0*q0 - q1*q1 - q2*q2 + q3*q3;

    const ex = ay*vz - az*vy;
    const ey = az*vx - ax*vz;
    const ez = ax*vy - ay*vx;

    if (MAHONY_KI > 0) {
      integralFBx += MAHONY_KI * ex * dt;
      integralFBy += MAHONY_KI * ey * dt;
      integralFBz += MAHONY_KI * ez * dt;
    }

    gx += MAHONY_KP * ex + integralFBx;
    gy += MAHONY_KP * ey + integralFBy;
    gz += MAHONY_KP * ez + integralFBz;
  }

  const halfDt = 0.5 * dt;
  const pq0 = q0, pq1 = q1, pq2 = q2, pq3 = q3;
  q0 += (-pq1*gx - pq2*gy - pq3*gz) * halfDt;
  q1 += ( pq0*gx + pq2*gz - pq3*gy) * halfDt;
  q2 += ( pq0*gy - pq1*gz + pq3*gx) * halfDt;
  q3 += ( pq0*gz + pq1*gy - pq2*gx) * halfDt;

  const qNorm = Math.sqrt(q0*q0 + q1*q1 + q2*q2 + q3*q3);
  if (qNorm > 1e-10) {
    q0 /= qNorm;  q1 /= qNorm;  q2 /= qNorm;  q3 /= qNorm;
  } else {
    q0 = 1; q1 = 0; q2 = 0; q3 = 0;
  }

  s.q0 = q0;  s.q1 = q1;  s.q2 = q2;  s.q3 = q3;
  s.integralFBx = integralFBx;
  s.integralFBy = integralFBy;
  s.integralFBz = integralFBz;
}
