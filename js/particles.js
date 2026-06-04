export class Particles {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this.particles = [];
    this.NUM = 500;
    this.state = 'idle';
    this.stateTime = 0;
    this.time = 0;
    this.cx = 0;
    this.cy = 0;
    this.W = 0;
    this.H = 0;

    this.currentColor = { r: 0, g: 208, b: 255 };
    this.targetColor = { r: 0, g: 208, b: 255 };

    this.COOL = { r: 0, g: 208, b: 255 };
    this.WARM = { r: 240, g: 160, b: 48 };
    this.MIX = { r: 120, g: 184, b: 152 };

    this.resize();
    this._initParticles();
    this._animating = false;
  }

  resize() {
    this.W = Math.min(window.innerWidth, 430);
    this.H = window.innerHeight;
    this.canvas.width = this.W * this.dpr;
    this.canvas.height = this.H * this.dpr;
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.cx = this.W / 2;
    this.cy = this.H * 0.30;

    // Update orb home positions
    for (let i = 0; i < this.particles.length; i++) {
      const pos = this._orbPos(i);
      this.particles[i].ox = pos.x;
      this.particles[i].oy = pos.y;
      if (this.state === 'idle') {
        this.particles[i].tx = pos.x;
        this.particles[i].ty = pos.y;
      }
    }
  }

  _orbPos(i) {
    const angle = (i / this.NUM) * Math.PI * 2 + Math.sin(i * 0.1) * 0.3;
    const r = 60 + Math.sin(i * 0.37) * 12 + Math.cos(i * 0.73) * 8;
    return { x: this.cx + Math.cos(angle) * r, y: this.cy + Math.sin(angle) * r };
  }

  _initParticles() {
    this.particles = [];
    for (let i = 0; i < this.NUM; i++) {
      const pos = this._orbPos(i);
      this.particles.push({
        x: pos.x, y: pos.y,
        tx: pos.x, ty: pos.y,
        ox: pos.x, oy: pos.y,
        vx: 0, vy: 0,
        size: 1.2 + Math.random() * 1.5,
        alpha: 0.4 + Math.random() * 0.6,
        hue: Math.random(),
        drift: Math.random() * Math.PI * 2,
        driftSpeed: 0.002 + Math.random() * 0.004,
        driftRadius: 1 + Math.random() * 3,
      });
    }
  }

  sampleText(text, size) {
    const tc = document.createElement('canvas');
    const tx = tc.getContext('2d');
    tc.width = this.W * 2;
    tc.height = size * 3;
    tx.fillStyle = '#fff';
    tx.font = `${size}px Syne, sans-serif`;
    tx.textAlign = 'center';
    tx.textBaseline = 'middle';
    tx.fillText(text, tc.width / 2, tc.height / 2);
    const img = tx.getImageData(0, 0, tc.width, tc.height);
    const points = [];
    const step = 3;
    for (let y = 0; y < tc.height; y += step) {
      for (let x = 0; x < tc.width; x += step) {
        if (img.data[(y * tc.width + x) * 4 + 3] > 128) {
          points.push({
            x: (x - tc.width / 2) * 0.5 + this.cx,
            y: (y - tc.height / 2) * 0.5 + this.cy
          });
        }
      }
    }
    // Limit to particle count
    if (points.length > this.NUM) {
      const sampled = [];
      const skip = points.length / this.NUM;
      for (let i = 0; i < points.length; i += skip) {
        sampled.push(points[Math.floor(i)]);
      }
      return sampled;
    }
    return points;
  }

  setState(newState, textTarget) {
    this.state = newState;
    this.stateTime = 0;

    switch (newState) {
      case 'idle':
        this.targetColor = this.COOL;
        this.particles.forEach((p, i) => {
          const pos = this._orbPos(i);
          p.tx = pos.x; p.ty = pos.y;
        });
        break;

      case 'listening':
        this.targetColor = this.COOL;
        this.particles.forEach((p, i) => {
          const pos = this._orbPos(i);
          p.tx = this.cx + (pos.x - this.cx) * 1.15;
          p.ty = this.cy + (pos.y - this.cy) * 1.15;
        });
        break;

      case 'dispersing':
        this.targetColor = this.MIX;
        this.particles.forEach(p => {
          const angle = Math.atan2(p.y - this.cy, p.x - this.cx) + (Math.random() - 0.5) * 1.5;
          const dist = 110 + Math.random() * 90;
          p.tx = this.cx + Math.cos(angle) * dist;
          p.ty = this.cy + Math.sin(angle) * dist;
          p.vx += (Math.random() - 0.5) * 3;
          p.vy += (Math.random() - 0.5) * 3;
        });
        break;

      case 'forming_text':
        this.targetColor = this.WARM;
        if (textTarget) {
          const targets = this.sampleText(textTarget, 48);
          if (targets.length > 0) {
            this.particles.forEach((p, i) => {
              const t = targets[i % targets.length];
              p.tx = t.x; p.ty = t.y;
            });
          }
        }
        break;

      case 'reconverging':
        this.targetColor = this.COOL;
        this.particles.forEach((p, i) => {
          const pos = this._orbPos(i);
          p.tx = pos.x; p.ty = pos.y;
        });
        break;
    }
  }

  start() {
    if (this._animating) return;
    this._animating = true;
    this._draw();
  }

  stop() {
    this._animating = false;
  }

  _draw() {
    if (!this._animating) return;
    this.time++;
    this.stateTime++;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);

    // Lerp color
    this.currentColor.r += (this.targetColor.r - this.currentColor.r) * 0.03;
    this.currentColor.g += (this.targetColor.g - this.currentColor.g) * 0.03;
    this.currentColor.b += (this.targetColor.b - this.currentColor.b) * 0.03;
    const cr = Math.round(this.currentColor.r);
    const cg = Math.round(this.currentColor.g);
    const cb = Math.round(this.currentColor.b);

    // Background glow
    const grd = ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, 180);
    grd.addColorStop(0, `rgba(${cr},${cg},${cb},0.06)`);
    grd.addColorStop(1, 'transparent');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, this.W, this.H);

    // Physics params per state
    const turbulence = this.state === 'listening' ? 1.5 :
                       this.state === 'dispersing' ? 3.0 :
                       this.state === 'forming_text' ? 0.3 : 0.5;
    const springK = this.state === 'dispersing' ? 0.02 :
                    this.state === 'forming_text' ? 0.06 :
                    this.state === 'reconverging' ? 0.05 : 0.04;
    const damping = 0.88;

    for (const p of this.particles) {
      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      p.vx += dx * springK;
      p.vy += dy * springK;

      p.drift += p.driftSpeed;
      p.vx += Math.cos(p.drift) * turbulence * 0.08;
      p.vy += Math.sin(p.drift) * turbulence * 0.08;

      p.vx *= damping;
      p.vy *= damping;
      p.x += p.vx;
      p.y += p.vy;

      const pr = Math.round(cr + (240 - cr) * p.hue * 0.3);
      const pg = Math.round(cg + (160 - cg) * p.hue * 0.3);
      const pb = Math.round(cb + (48 - cb) * p.hue * 0.3);

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${pr},${pg},${pb},${p.alpha})`;
      ctx.fill();
    }

    // Inner glow when in orb form
    if (this.state === 'idle' || this.state === 'listening' || this.state === 'reconverging') {
      const breathe = Math.sin(this.time * 0.02) * 0.3 + 0.7;
      const ig = ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, 50);
      ig.addColorStop(0, `rgba(${cr},${cg},${cb},${(0.08 * breathe).toFixed(3)})`);
      ig.addColorStop(1, 'transparent');
      ctx.fillStyle = ig;
      ctx.fillRect(this.cx - 80, this.cy - 80, 160, 160);
    }

    requestAnimationFrame(() => this._draw());
  }
}
