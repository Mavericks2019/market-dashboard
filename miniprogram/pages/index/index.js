const { API_BASE_URL, REFRESH_INTERVAL } = require('../../config')

const PERIODS = [
  { value: '1D', label: '日内' },
  { value: '5D', label: '5日' },
  { value: '1M', label: '1月' },
  { value: '3M', label: '3月' },
]

function formatNumber(value) {
  if (!Number.isFinite(value)) return '--'
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatSigned(value, percent = false) {
  if (!Number.isFinite(value)) return '--'
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}${percent ? '%' : ''}`
}

function formatChinaTime(seconds, includeDate = false) {
  if (!seconds) return '--:--:--'
  const date = new Date(seconds * 1000)
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: includeDate ? '2-digit' : undefined,
      day: includeDate ? '2-digit' : undefined,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date)
  } catch (error) {
    return date.toLocaleString()
  }
}

function formatPointTime(seconds, period) {
  const date = new Date(seconds * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  if (period === '1D') return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
}

function normalizeMarket(market) {
  const positive = (market.change || 0) >= 0
  return {
    ...market,
    positive,
    priceText: formatNumber(market.price),
    previousCloseText: formatNumber(market.previousClose),
    changeText: formatSigned(market.change),
    changePercentText: formatSigned(market.changePercent, true),
    lowText: formatNumber(market.dayLow),
    highText: formatNumber(market.dayHigh),
    timeText: formatChinaTime(market.marketTime, true),
  }
}

Page({
  data: {
    markets: [],
    activeMarket: null,
    activeKey: 'NQ',
    periods: PERIODS,
    period: '1D',
    loading: true,
    refreshing: false,
    error: '',
    chinaTime: '--:--:--',
    sessionLabel: '读取交易状态',
    sessionTone: 'closed',
    delayLabel: '参考行情 · 延迟未知',
    feedName: '',
    hoverPoint: null,
  },

  onLoad() {
    this.updateClock()
    this.fetchMarkets(false)
  },

  onShow() {
    this.stopTimers()
    this.refreshTimer = setInterval(() => this.fetchMarkets(true), REFRESH_INTERVAL)
    this.clockTimer = setInterval(() => this.updateClock(), 1000)
  },

  onHide() {
    this.stopTimers()
  },

  onUnload() {
    this.stopTimers()
  },

  onPullDownRefresh() {
    this.fetchMarkets(true).finally(() => wx.stopPullDownRefresh())
  },

  stopTimers() {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.clockTimer) clearInterval(this.clockTimer)
    this.refreshTimer = null
    this.clockTimer = null
  },

  updateClock() {
    this.setData({
      chinaTime: formatChinaTime(Math.floor(Date.now() / 1000)),
    })
  },

  requestMarkets() {
    return new Promise((resolve, reject) => {
      wx.request({
        url: `${API_BASE_URL}/api/markets`,
        method: 'GET',
        data: { period: this.data.period },
        timeout: 10000,
        success: (response) => {
          if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data)
          else reject(new Error(response.data?.error || `接口返回 ${response.statusCode}`))
        },
        fail: (error) => reject(new Error(error.errMsg || '网络连接失败')),
      })
    })
  },

  async fetchMarkets(silent = false) {
    if (this.fetching) return
    this.fetching = true
    this.setData(silent ? { refreshing: true } : { loading: true, error: '' })
    try {
      const response = await this.requestMarkets()
      const markets = (response.markets || []).map(normalizeMarket)
      const activeMarket = markets.find((item) => item.key === this.data.activeKey) || markets[0] || null
      const partialError = response.errors?.length ? '部分趋势数据未更新' : ''
      this.setData({
        markets,
        activeMarket,
        activeKey: activeMarket?.key || this.data.activeKey,
        feedName: response.feed || '公开行情',
        delayLabel: response.delay || '参考行情 · 延迟未知',
        sessionLabel: response.session?.label || this.data.sessionLabel,
        sessionTone: response.session?.phase || this.data.sessionTone,
        error: partialError,
      }, () => this.drawChart())
    } catch (error) {
      this.setData({ error: error.message || '行情加载失败' })
    } finally {
      this.fetching = false
      this.setData({ loading: false, refreshing: false })
    }
  },

  handleRefresh() {
    this.fetchMarkets(true)
  },

  selectMarket(event) {
    const activeKey = event.currentTarget.dataset.key
    const activeMarket = this.data.markets.find((item) => item.key === activeKey)
    if (!activeMarket) return
    this.setData({ activeKey, activeMarket, hoverPoint: null }, () => this.drawChart())
  },

  selectPeriod(event) {
    const period = event.currentTarget.dataset.period
    if (period === this.data.period) return
    this.setData({ period, hoverPoint: null }, () => this.fetchMarkets(false))
  },

  drawChart(crosshairIndex = null) {
    const points = this.data.activeMarket?.points || []
    if (points.length < 2) return
    const query = wx.createSelectorQuery().in(this)
    query.select('#trendCanvas').fields({ node: true, size: true }).exec((result) => {
      const entry = result[0]
      if (!entry?.node || !entry.width || !entry.height) return
      const canvas = entry.node
      const ctx = canvas.getContext('2d')
      const dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio
      canvas.width = entry.width * dpr
      canvas.height = entry.height * dpr
      ctx.scale(dpr, dpr)
      this.chartMetrics = { left: 14, right: 48, top: 18, bottom: 28, width: entry.width, height: entry.height }
      this.renderChart(ctx, points, crosshairIndex)
    })
  },

  renderChart(ctx, points, crosshairIndex) {
    const { left, right, top, bottom, width, height } = this.chartMetrics
    const plotWidth = width - left - right
    const plotHeight = height - top - bottom
    const values = points.map((point) => Number(point.close)).filter(Number.isFinite)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const padding = Math.max((max - min) * 0.1, max * 0.0005)
    const low = min - padding
    const high = max + padding
    const positive = this.data.activeMarket.positive
    const color = positive ? '#f06470' : '#31c981'
    const xAt = (index) => left + (index / (points.length - 1)) * plotWidth
    const yAt = (value) => top + ((high - value) / (high - low)) * plotHeight

    ctx.clearRect(0, 0, width, height)
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.fillStyle = '#707987'
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'right'
    for (let row = 0; row <= 4; row += 1) {
      const y = top + (row / 4) * plotHeight
      ctx.beginPath()
      ctx.moveTo(left, y)
      ctx.lineTo(width - right, y)
      ctx.stroke()
      const label = high - (row / 4) * (high - low)
      ctx.fillText(formatNumber(label), width - 3, y + 3)
    }

    const gradient = ctx.createLinearGradient(0, top, 0, height - bottom)
    gradient.addColorStop(0, positive ? 'rgba(240,100,112,0.25)' : 'rgba(49,201,129,0.25)')
    gradient.addColorStop(1, 'rgba(9,11,15,0)')
    ctx.beginPath()
    points.forEach((point, index) => {
      const x = xAt(index)
      const y = yAt(point.close)
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.lineTo(xAt(points.length - 1), height - bottom)
    ctx.lineTo(left, height - bottom)
    ctx.closePath()
    ctx.fillStyle = gradient
    ctx.fill()

    ctx.beginPath()
    points.forEach((point, index) => {
      const x = xAt(index)
      const y = yAt(point.close)
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.fillStyle = '#707987'
    ctx.textAlign = 'left'
    ctx.fillText(formatPointTime(points[0].time, this.data.period), left, height - 7)
    ctx.textAlign = 'right'
    ctx.fillText(formatPointTime(points[points.length - 1].time, this.data.period), width - right, height - 7)

    if (crosshairIndex !== null && points[crosshairIndex]) {
      const point = points[crosshairIndex]
      const x = xAt(crosshairIndex)
      const y = yAt(point.close)
      ctx.setLineDash([3, 3])
      ctx.strokeStyle = '#7f8998'
      ctx.beginPath()
      ctx.moveTo(x, top)
      ctx.lineTo(x, height - bottom)
      ctx.moveTo(left, y)
      ctx.lineTo(width - right, y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(x, y, 4, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
    }
  },

  handleChartTouch(event) {
    const points = this.data.activeMarket?.points || []
    if (!this.chartMetrics || points.length < 2 || !event.touches?.length) return
    const { left, right, width } = this.chartMetrics
    const x = Math.max(left, Math.min(width - right, event.touches[0].x))
    const ratio = (x - left) / (width - left - right)
    const index = Math.round(ratio * (points.length - 1))
    const point = points[index]
    this.setData({
      hoverPoint: {
        priceText: formatNumber(point.close),
        timeText: formatPointTime(point.time, this.data.period),
      },
    })
    this.drawChart(index)
  },

  clearChartTouch() {
    this.setData({ hoverPoint: null })
    this.drawChart()
  },
})
