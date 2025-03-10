import prompts from 'prompts'
import chalk from 'chalk'
import puppeteer from 'puppeteer'
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import pLimit from 'p-limit'
import ora from 'ora'

// 限制并发数为 5
const limit = pLimit(5)
// 获取页面中的所有链接
const getUrls = async (url) => {
  try {
    const browser = await puppeteer.launch()
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    // 获取整个页面内容
    const content = await page.content()
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
    await browser.close()
    return uniqueUrls
  } catch (error) {
    console.log(chalk.red('致命错误:', error.message))
    process.exit(1) // 非零退出码表示失败
  }
}
// 获取用户输入
const getUserInput = async () => {
  const { targetUrl, usePath } = await prompts([
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
  ])
  return { targetUrl, usePath }
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

      const type = response.headers['content-type']
      if (/image/.test(type) && !/svg/.test(url)) {
        let filename =
          url
            .split('/')
            .pop()
            .match(/.*\.(?=[^\.]*$)/)[0]
            .replace(/(\#|\?).*/, '') +
          (/\?/.test(url) ? `_${/\?(.*)/.exec(url)[1]}` : '') +
          `.${type.split('/')[1] || 'bin'}`
        // fs.existsSync(path.join(dirPath, filename))
        //   ? (filename = `${filename.split('.')[0]}_${Date.now()}.${filename.split('.')[1]}`)
        //   : ''

        await new Promise((resolve, reject) => {
          response.data
            .pipe(fs.createWriteStream(path.join(dirPath, filename)))
            .on('finish', resolve)
            .on('error', reject)
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
    const { targetUrl, usePath } = await getUserInput()
    const loading = ora('正在获取图片链接...').start()
    const urls = await getUrls(targetUrl)
    loading.succeed(`获取图片链接成功: ${urls.length}`)
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
