import prompts from 'prompts'
import chalk from 'chalk'
import puppeteer from 'puppeteer'
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import pLimit from 'p-limit'
import ora from 'ora'
import { fileTypeFromStream } from 'file-type'

// 限制并发数为 5
const limit = pLimit(5)
// 获取图片url
const getImgUrl = async (url, content) => {
  const srcs = [...content.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*>/g)].map((item) => {
    if (/^https?:\/\//.test(item[1])) {
      return item[1]
    } else {
      const urlObj = new URL(item[1], url)
      return urlObj.toString()
    }
  })
  const urls = content
    .match(/"(https:.+?)"/g)
    .map((item) => item.replace(/"/g, ''))
    .filter((item) => {
      const ext = path.extname(item.replace(/\?.+|\/\#.+/g, '')).toLowerCase()
      if (ext === '') return true
      return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)
    })
  const uniqueUrls = [...new Set([...srcs, ...urls])]

  return uniqueUrls
}
// 获取页面内容
const getPage = async (url, headless = true) => {
  try {
    const browser = await puppeteer.launch({ headless })
    const page = await browser.newPage()
    let content = ''
    if (headless) {
      // 设置浏览器伪装
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...')
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
      })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      // 获取整个页面内容
      content = await page.content()
    } else {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      // 启动实时缓存
      await new Promise((resolve) => {
        let timer = setInterval(() => {
          content = page.evaluate(() => document.documentElement.outerHTML)
        }, 1000)
        page.on('close', () => {
          resolve()
          clearInterval(timer)
        })
      })
    }
    await browser.close()
    return content
  } catch (error) {
    console.log(chalk.red('致命错误:', error.message))
    process.exit(1) // 非零退出码表示失败
  }
}
// 获取用户输入
const getUserInput = async () => {
  const { targetUrl, usePath, headless } = await prompts([
    {
      type: 'text',
      name: 'targetUrl',
      message: '请输入目标网址',
      validate: (value) => !!value || '不能为空',
    },
    {
      type: 'text',
      name: 'usePath',
      message: '请输入保存路径(可选，默认保存在当前目录下的images文件夹中)',
      validate: (value) => {
        if (!value) {
          return true
        }
        const illegalChars = /[\\/:*?"<>|]/
        return !illegalChars.test(value) || '路径包含非法字符'
      },
    },
    {
      type: 'confirm',
      name: 'headless',
      message: '是否使用无头模式(可选，默认使用)',
      initial: true,
    },
  ])
  return { targetUrl, usePath, headless }
}
// 初始化目录
const initDirectory = (usePath) => {
  let dirPath = ''
  usePath.trim() ? (dirPath = path.resolve(usePath)) : (dirPath = path.resolve('./images'))
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
  return dirPath
}
// 下载图片（带重试）
const downloadWithRetry = async (url, dirPath, maxRetries = 3) => {
  let retries = 0
  while (retries <= maxRetries) {
    try {
      const response = await axios.get(url, { responseType: 'stream', timeout: 10000 })
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`)

      const fileType = await fileTypeFromStream(response.data)

      if (fileType && /image/.test(fileType.mime)) {
        let filename = url.split('/').pop().replace(/\#|\?/, '')
        const extName = fileType.ext
        if (filename.includes(extName)) {
          filename = filename.split(`.${extName}`).join('') + `.${extName}`
        } else {
          filename = filename + `.${extName}`
        }
        const filePath = path.join(dirPath, filename)
        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(filePath)
          response.data.pipe(writer).on('finish', resolve).on('error', reject)
          // 设置超时
          let timeoutId
          response.data.on('data', () => {
            timeoutId && clearTimeout(timeoutId)
            timeoutId = setTimeout(() => {
              writer.destroy()
              response.data.destroy()
              reject(new Error('下载超时'))
            }, 30000)
          })
        })
        return { success: true, url }
      }
      return { success: false, url, error: { message: 'Not an image' } }
    } catch (error) {
      if (retries === maxRetries) {
        return { success: false, url, error }
      }
      retries++
      console.log(chalk.yellow(`⚠️ 重试 ${url} (${retries}/${maxRetries})`))
      await new Promise((resolve) => setTimeout(resolve, 1000 * retries))
    }
  }
}
// 下载函数
const downloadImage = (urls, dirPath) => {
  let successCount = 0
  let failCount = 0

  return urls.map((url) =>
    limit(async () => {
      const result = await downloadWithRetry(url, dirPath)
      if (result.success) {
        console.log(chalk.green(`✅ 下载成功 (${++successCount}/${urls.length}): ${url}`))
      } else {
        console.log(
          chalk.red(
            `❌ 下载失败 (${++failCount}/${urls.length}): ${url} (原因: ${result.error?.message})`
          )
        )
      }
    })
  )
}
// 主函数
const createDownload = async () => {
  try {
    const { targetUrl, usePath, headless } = await getUserInput()
    const loading = ora('正在获取页面内容...').start()
    const content = await getPage(targetUrl, headless)
    loading.succeed('获取页面内容成功')
    loading.start('正在获取图片链接...')
    const urls = await getImgUrl(targetUrl, content)
    loading.succeed(`获取图片链接成功: ${urls.length}`)
    // loading.succeed(`获取图片链接成功: ${urls.length}`)
    const dirPath = initDirectory(usePath)
    await Promise.all(downloadImage(urls, dirPath))
    console.log(chalk.green('✅下载完成'))
    await createDownload()
  } catch (error) {
    console.log(chalk.red('全局捕获错误:', error.message))
    process.exit(1)
  }
}

createDownload()
