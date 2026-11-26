import qrcodeGenerator from 'qrcode-generator';

// QR modules of `text`: true is a dark module. Type number 0 picks the smallest
// version, level M, byte mode. The text goes in as UTF-8 bytes, because the
// library keeps only the low byte of each UTF-16 code unit.
export function qrMatrix(text:string):boolean[][]{
 const qr=qrcodeGenerator(0,'M');
 qr.addData(Array.from(new TextEncoder().encode(text),byte=>String.fromCharCode(byte)).join(''),'Byte');
 qr.make();
 const size=qr.getModuleCount();
 return Array.from({length:size},(_,row)=>Array.from({length:size},(_,column)=>qr.isDark(row,column)));
}
