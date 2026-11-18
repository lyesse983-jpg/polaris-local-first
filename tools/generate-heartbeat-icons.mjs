import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

// Debug resource overlay only: release branding remains owned by the original app.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const res = path.join(root, 'android/app/src/debug/res');
const source = PNG.sync.read(fs.readFileSync(path.join(root, 'tools/assets/polaris-heartbeat-foreground.png')));
const background = [196, 216, 229]; // #C4D8E5
const densities = [['mdpi',48,108],['hdpi',72,162],['xhdpi',96,216],['xxhdpi',144,324],['xxxhdpi',192,432]];
function canvas(width, color) {
  const png = new PNG({width, height: width});
  for(let p=0; p<png.data.length; p+=4) png.data.set(color,p);
  return png;
}
export function render(size, adaptive=false, scaleOverride) {
  const output = canvas(size, adaptive ? [0,0,0,0] : [...background,255]);
  // Adaptive foreground must remain inside Android's safe area under launcher masks.
  const scale = scaleOverride ?? (adaptive ? 0.72 : 1);
  const side = Math.round(size*scale), offset = Math.floor((size-side)/2);
  for(let y=0; y<side; y++) for(let x=0; x<side; x++) {
    const left=x*source.width/side, right=(x+1)*source.width/side;
    const top=y*source.height/side, bottom=(y+1)*source.height/side;
    const color=[0,0,0]; let coverage=0;
    const area=(right-left)*(bottom-top);
    for(let sy=Math.floor(top);sy<Math.ceil(bottom);sy++) for(let sx=Math.floor(left);sx<Math.ceil(right);sx++) {
      const weight=(Math.min(right,sx+1)-Math.max(left,sx))*(Math.min(bottom,sy+1)-Math.max(top,sy));
      const from=(Math.min(sy,source.height-1)*source.width+Math.min(sx,source.width-1))*4;
      const covered=weight*source.data[from+3]/255; coverage+=covered;
      for(let c=0;c<3;c++) color[c]+=source.data[from+c]*covered;
    }
    const alpha=coverage/area, to=((y+offset)*size+x+offset)*4;
    for(let c=0;c<3;c++) output.data[to+c]=adaptive
      ? (coverage ? Math.round(color[c]/coverage) : 0)
      : Math.round(color[c]/area+background[c]*(1-alpha));
    output.data[to+3]=adaptive ? Math.round(alpha*255) : 255;
  }
  return output;
}
for(const [density,size,foreground] of densities) {
  const dir=path.join(res,'mipmap-'+density); fs.mkdirSync(dir,{recursive:true});
  const legacy=render(size);
  fs.writeFileSync(path.join(dir,'ic_launcher.png'),PNG.sync.write(legacy));
  fs.writeFileSync(path.join(dir,'ic_launcher_round.png'),PNG.sync.write(legacy));
  fs.writeFileSync(path.join(dir,'ic_launcher_foreground.png'),PNG.sync.write(render(foreground,true)));
}
fs.mkdirSync(path.join(res,'values'),{recursive:true});
fs.writeFileSync(path.join(res,'values/ic_launcher_background.xml'),'<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="ic_launcher_background">#C4D8E5</color></resources>\n');
fs.mkdirSync(path.join(res,'mipmap-anydpi-v26'),{recursive:true});
const adaptive='<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n';
for(const name of ['ic_launcher','ic_launcher_round']) fs.writeFileSync(path.join(res,'mipmap-anydpi-v26',name+'.xml'),adaptive);
console.log('Generated debug launcher icons with #C4D8E5 background.');
