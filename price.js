import http from 'http';
import rp from 'request-promise-native';
import request from 'request';
import util from 'util';
import RedisServer from 'redis-server';
import redis from 'redis';
import express from 'express';
import iconv from 'iconv-lite';

var cors = require('cors')

var options = {
      jar : true,
      baseUrl: 'http://163.29.17.179/stock/'
    };

var mapStockName = {};

function twseParseGetStockNameResult(body)
{
  let ret = null;
  let resp = JSON.parse(body);
  if (resp && resp['datas'].length > 0)
  {
    var name = resp['datas'][0]['key'];
    var regex = /(.*)_.*/g;
    var m = regex.exec(name);
    if (m && m.length > 1)
      ret = m[1];
  }
  return ret;
}
function twseParse(html)
{
  let json = JSON.parse(html);
  let date = json.sysDate;
  let time = json.sysTime;

  let result = json.msgArray.map( (msg) => {
    return {
      'name':msg.n,
      'code':msg.c,
      'price':msg.z
    }
  });
  return result;
}

function twsePoke(stockIDFull)
{
  options.uri = '/index.jsp';
  options.transform = (body) => {return stockIDFull};
  return rp(options);
}

function twseGetStockName(stockID)
{
  let timestamp = Date.now() + 6000;
  options.uri =  `api/getStockNames.jsp?n=${stockID}&_=${timestamp}`;
  options.transform =  function (body, response, resolveWithFullResponse) {
    return twseParseGetStockNameResult(body);
  }
  
  return rp(options);
}

async function twseGetStockPriceWithNames(stockIDArray)
{
  if (!Array.isArray(stockIDArray))
    stockIDArray = [stockIDArray];

  options.uri = '/index.jsp';
  options.transform = null;
  let body = await rp(options);
  console.log('poke done');

  options.uri = '/api/getStockInfo.jsp';
  options.qs = {json: 1, delay: 0, _: Date.now() + 6000, ex_ch: ''};
  options.transform = (body) => { return twseParse(body)};
  stockIDArray.forEach( (stockID) => {
    if (options.qs.ex_ch == '')
      options.qs.ex_ch += stockID;
    else
      options.qs.ex_ch += '|' + stockID;
  });
  let priceResult = await rp(options);
  return priceResult;
}

async function twseGetStockPriceAsync(stockID)
{
  let timestamp = Date.now() + 6000;
  options.uri =  `api/getStockNames.jsp?n=${stockID}&_=${timestamp}`;
  options.transform =  function (body, response, resolveWithFullResponse) {
    return twseParseGetStockNameResult(body);
  }
  let nameResult = await rp(options);
  console.log('name result:'+util.inspect(nameResult));

  options.uri = '/index.jsp';
  options.transform = null;
  let body = await rp(options);
  console.log('poke done');

/*
  let stockIDArray = [stockID];
  if (!Array.isArray(stockIDArray))
    stockIDArray = [stockIDArray];
*/
  options.uri = '/api/getStockInfo.jsp';
  options.qs = {json: 1, delay: 0, _: Date.now() + 6000, ex_ch: ''};
  options.transform = (body) => { return twseParse(body)};
  /*
  stockIDArray.forEach( (stockID) => {
    if (options.qs.ex_ch == '')
      options.qs.ex_ch += stockID;
    else
      options.qs.ex_ch += '|' + stockID;
  });
  */
  options.qs.ex_ch += nameResult;
  let priceResult = await rp(options);
  console.log('price result:'+priceResult);
  return priceResult;

}
async function getDividend(stockID)
{
  var url = 'https://tw.stock.yahoo.com/d/s/dividend_'+stockID+'.html';
  const regex = /[\s\S]*<table.*>[\s\S]*?<td align="center" height="25">(.*)<\/td>\s*<td align="center">(.*)<\/td>\s*<td align="center">(.*)<\/td>\s*<td align="center">(.*)<\/td>\s*<td align="center">(.*)<\/td>\s*<td align="center">(.*)<\/td>\s*<\/tr>/g;
  var respString = await rp(url);
  //console.log('respString:'+respString);
  var m = regex.exec(respString);
  if (m == null)
  {
    return {cash:'error',stock:'error'};
  }
  return {cash:m[2],stock:m[5]};
}

async function getStock(stockIDList)
{
  let namesList = await Promise.all(stockIDList.map( async (stockID) => {
    if (mapStockName[stockID] === undefined) {
      mapStockName[stockID] = await twseGetStockName(stockID);
    }
    return mapStockName[stockID];
  }))

  let result = await twseGetStockPriceWithNames(namesList);

  return result;
}

async function getStock_day_avg(stockID,dateString)
{
  console.log('aaaa')

  let option = {
    uri : 'http://www.twse.com.tw/exchangeReport/STOCK_DAY_AVG',
    qs : {'response':'json','date':dateString,'stockNo':stockID},
    json : true
  }
  let result = rp(option)
  return result
}

async function getTAIEX(dateString)
{
  let today = new Date()
  if (typeof dateString == 'undefined')
    dateString = ''+today.getFullYear()+(today.getMonth()+1)+today.getDate()
  console.log('getTAIEX: dateString='+dateString)
  let option = {
    uri : 'http://www.twse.com.tw/exchangeReport/FMTQIK',
    qs : {'response':'json','date' : dateString },
    json: true
  }
  return rp(option)
}

function twse_util_dateString_MonthShift(today,steps) {
  let year = today.getFullYear()
  let month = today.getMonth() + 1
  let date = today.getDate()

  let strYear;
  let strMonth;
  let strDate;

  month = month + steps
  while (month > 12) {
    month -= 12
    year++
  }

  while (month < 1) {
    month += 12
    year--
  }
  if (month < 10) 
    return ''+year+'0'+month+date
  else
    return ''+year+month+date

  
}

async function strategy_20day(stockID)
{
  /*
  x = (股價-加權指數) / (股價+加權指數)
  y = (前20天x平均值)
  以橫軸為日期,縱軸為x,y作圖
  */

  let today = new Date()
  let x = []
  const window = 20
  const monthShifts = [-2,-1,0] //抓近三個月
  for (var key in monthShifts) 
  {
    let dateString = twse_util_dateString_MonthShift(today,monthShifts[key])
    console.log('dateString:'+dateString)
    let prices = await getStock_day_avg(stockID,dateString)
    let taiex = await getTAIEX(dateString)

    for (var i=0;i<taiex.data.length;i++) {
      let day = {}
      /* 106/12/20 => 20171220 */
      let tokens = prices.data[i][0].split('/')
      dateString = '' + (parseInt(tokens[0])+1911)+tokens[1]+tokens[2]
      day.date = dateString
      day.price = parseFloat(prices.data[i][1])
      day.taiex = parseFloat(taiex.data[i][4].replace(',',''))
      day.x = (day.price - day.taiex) / (day.price + day.taiex) * -1
      day.y = 0.0
      x.push(day)
    }
  }
  
  
  var subtotal = 0.0
  for (var i=0;i<x.length;i++) {
    subtotal += x[i].x
    if (i >= window) {
      subtotal -= x[i-window].x
    }
    if (i >= window-1)
      x[i].y = subtotal / window
    console.log(util.inspect(x[i]))
  }
  return x
}
/*
const server = new RedisServer(6379);
const client = redis.createClient();

client.on("error", function (err) {
    console.log("redis client error " + err);
});

client.on("connect", function () {
    console.log("redis client connected");
});


server.open().then(() => {
  console.log('redis server ready');
});
*/

async function test()
{
  //console.log(util.inspect(await getDividend('2317')));
  //console.log(util.inspect(await getDividend('3260')));
  //console.log(util.inspect(await twseGetStockPriceAsync('2317')));
  //console.log(util.inspect(await getStock(['2317','3260','2330'])));
  //console.log(util.inspect(await getStock_day_avg('2317','20171201')));
  //console.log(util.inspect(await getTAIEX('20171201')));
  strategy_20day('2317')
}

async function main()
{
  const app = express()

  app.use(cors())
  app.get('/', function (req, res) {
    var fs = require('fs');
    var marky = require("marky-markdown-lite")
    var contents = fs.readFileSync('README.md', 'utf8');
    var html = marky(contents)
    res.send(html)
  })

  app.get('/price', async function(req, res) {
    if (req.query.stock) {
      let dividend = await getDividend(req.query.stock);
      let price = await twseGetStockPriceAsync(req.query.stock);

      console.log(util.inspect(dividend));
      console.log(util.inspect(price));
      res.json({'name':price[0].name,'price':price[0].price,'dividend_cash':dividend.cash,'dividend_stock':dividend.stock});
    }
  })

  app.get('/price2', async function(req, res) {
    if (req.query.stock) {

      let result = await getStock(req.query.stock.split(','));
      await Promise.all(result.map( async (stock) => {
        let dividend = await getDividend(stock.code);
        stock.dividend_cash = dividend.cash;
        stock.dividend_stock = dividend.stock;
      }));
      console.log(util.inspect(result));
      res.json(result);
    }
  })

  app.get('/plot', async function(req,res) {

    res.sendfile('plot.html')
  })

  console.log('API: '+getTAIEX.name)
  app.get('/'+getTAIEX.name, async function (req,res) {
    let result = await getTAIEX(req.query.date)
    res.json(result.data)
  })

  console.log('API: '+getStock_day_avg.name)
  app.get('/'+getStock_day_avg.name, async function (req,res) {
    let result = await getStock_day_avg(req.query.stockID,req.query.date)
    res.json(result.data)
  })

  console.log('API: '+strategy_20day.name)
  app.get('/'+strategy_20day.name, async function (req,res) {
    let result = await strategy_20day(req.query.stockID)
    res.json(result)
  })

  let server = app.listen(process.env.PORT || 3000, function () {
    console.log('Example app listening on port '+server.address().port);
  })
}

main()

