import { readSetting, writeSetting } from '../../shared/storage'

export const loadLanguage = () => readSetting('language', 'en')
export const saveLanguage = (lang: string) => writeSetting('language', lang)
