/* orbit.js - demo target for the qjs-debugger GUI screenshot:
   break Body.prototype.advance, watch this.pos.x, step around. */

class Body {
  constructor(name, mass) {
    this.name = name;
    this.mass = mass;
    this.pos = { x: 0, y: 0 };
    this.vel = { x: 0, y: 0 };
  }

  advance(dt) {
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    return this.pos;
  }
}

function energy(body) {
  const v2 = body.vel.x ** 2 + body.vel.y ** 2;
  return 0.5 * body.mass * v2;
}

function main() {
  const moon = new Body('moon', 7.34e22);
  moon.vel = { x: 1.022, y: 0.03 };

  for(let step = 1; step <= 3; step++) {
    const p = moon.advance(60);
    console.log(`step ${step}: x=${p.x.toFixed(2)} y=${p.y.toFixed(2)}`);
  }

  console.log('kinetic energy:', energy(moon));
}

main();
