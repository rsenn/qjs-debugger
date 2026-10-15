function sum(n) {
  let s = 0;
  for(let i = 1; i <= n; i++) {
    s += i;
  }
  return s;
}
function boom() {
  throw new Error('boom');
}
console.log(sum(4));
try {
  boom();
} catch(e) {
  console.log('caught');
}
console.log('end');
