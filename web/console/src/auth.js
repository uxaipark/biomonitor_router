// Logged-in account (from /api/auth/me) shared by every page: permissions decide which menus exist and whether
// personal data / biosignals are shown. The router enforces the same rules on every API call — this only keeps the
// UI from offering what the server would refuse.
import { createContext, useContext } from 'react'

export const MeContext = createContext(null)
export const useMe = () => useContext(MeContext)

/** level of a resource for this account: 0 없음 · 1 보기 · 2 편집 */
export const levelOf = (me, res) => me?.perms?.[res] ?? 0
export const can = (me, res, lv = 1) => levelOf(me, res) >= lv
export const canPhi = (me) => can(me, 'data.phi')
export const canBio = (me) => can(me, 'data.biosignal')

export const LEVEL_LABEL = ['없음', '보기', '편집']
