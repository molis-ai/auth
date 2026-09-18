export class TeamAvatarError extends Error {
  readonly code: 'size' | 'format' | 'read' | 'process'
  constructor(code: 'size' | 'format' | 'read' | 'process') { super(code); this.code=code }
}
export function validateTeamAvatar(file: Pick<File,'size'|'type'>) {
  if (file.size > 5 * 1024 * 1024) throw new TeamAvatarError('size')
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new TeamAvatarError('format')
}
export function readTeamAvatar(file: File): Promise<string> {
  validateTeamAvatar(file)
  return new Promise((resolve,reject) => {
    const reader=new FileReader()
    reader.onload=()=>typeof reader.result==='string' && reader.result.startsWith('data:image/') ? resolve(reader.result) : reject(new TeamAvatarError('read'))
    reader.onerror=reader.onabort=()=>reject(new TeamAvatarError('read'))
    reader.readAsDataURL(file)
  })
}
export async function prepareTeamAvatar(file: File): Promise<string> {
  const data=await readTeamAvatar(file)
  try {
    const image=new Image(); image.src=data; await image.decode()
    const size=Math.min(image.naturalWidth,image.naturalHeight)
    if (!size) throw new TeamAvatarError('process')
    const canvas=document.createElement('canvas');canvas.width=canvas.height=128
    const context=canvas.getContext('2d');if(!context)throw new TeamAvatarError('process')
    context.drawImage(image,(image.naturalWidth-size)/2,(image.naturalHeight-size)/2,size,size,0,0,128,128)
    const result=canvas.toDataURL('image/png')
    if(!result.startsWith('data:image/png;base64,'))throw new TeamAvatarError('process')
    return result
  } catch { throw new TeamAvatarError('process') }
}
