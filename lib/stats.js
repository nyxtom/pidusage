var os = require('os')
var fs = require('fs')
var p = require('path')
var exec = require('child_process').exec
var spawn = require('child_process').spawn
var helpers = require('./helpers')
var format = require('util').format

var stats = {
  history: Object.create(null),
  cpu: null, //used to store cpu informations
  proc: function(pid, options, done) {
    var self = this

    if(this.cpu !== null) {
      fs.readFile('/proc/uptime', 'utf8', function(err, uptime) {
        if(err)
          return done(err, null)

        if(uptime === undefined) {
          console.error("[pidusage] We couldn't find uptime from /proc/uptime")
          self.cpu.uptime = os.uptime()
        } else {
          self.cpu.uptime = uptime.split(' ')[0]
        }

        return self.proc_calc(pid, options, done)
      })
    } else {
      helpers.cpu(function(err, cpu) {
        if(err)
          return done(err, null)

        self.cpu = cpu
        return self.proc_calc(pid, options, done)
      })
    }
  },
  proc_calc: function(pid, options, done) {
    var history = this.history[pid] ? this.history[pid] : Object.create(null)
    var cpu = this.cpu
    var self = this

    //Arguments to path.join must be strings
    fs.readFile(p.join('/proc', ''+pid, 'stat'), 'utf8', function(err, infos) {

      if(err)
        return done(err, null)

      //https://github.com/arunoda/node-usage/commit/a6ca74ecb8dd452c3c00ed2bde93294d7bb75aa8
      //preventing process space in name by removing values before last ) (pid (name) ...)
      var index = infos.lastIndexOf(')')
      infos = infos.substr(index + 2).split(' ')

      //according to http://man7.org/linux/man-pages/man5/proc.5.html (index 0 based - 2)
      //In kernels before Linux 2.6, start was expressed in jiffies. Since Linux 2.6, the value is expressed in clock ticks
      var stat = {
          utime: parseFloat(infos[11]),
          stime: parseFloat(infos[12]),
          cutime: parseFloat(infos[13]),
          cstime: parseFloat(infos[14]),
          start: parseFloat(infos[19]) / cpu.clock_tick,
          rss: parseFloat(infos[21]),
          seconds: 0,
          uptime: 0
      }

      //http://stackoverflow.com/questions/16726779/total-cpu-usage-of-an-application-from-proc-pid-stat/16736599#16736599

      var childrens = options.childrens ? stat.cutime + stat.cstime : 0

      var total = stat.stime - (history.stime || 0) + stat.utime - (history.utime || 0) + childrens

      total = total / cpu.clock_tick

      //time elapsed between calls
      var seconds = history.uptime !== undefined ? cpu.uptime - history.uptime : stat.start - cpu.uptime
      seconds = Math.abs(seconds)
      seconds = seconds === 0 ? 0.1 : seconds //we sure can't divide through 0

      self.history[pid] = stat
      self.history[pid].seconds = seconds
      self.history[pid].uptime = cpu.uptime

      return done(null, {
        cpu: (total / seconds) * 100,
        memory: stat.rss * cpu.pagesize
      })
    })
  },
  /**
   * Get pid informations through ps command
   * @param  {int}   pid
   * @return  {Function} done (err, stat)
   * on os x skip headers with pcpu=,rss=
   * on linux it could be --no-header
   * on solaris 11 can't figure out a way to do this properly so...
   */
  ps: function(pid, options, done) {

    var cmd = 'ps -o pcpu,rss -p '

    if(os.platform() == 'aix')
      cmd = 'ps -o pcpu,rssize -p ' //this one could work on other platforms

    exec(cmd + pid, function(err, stdout, stderr) {
      if(err)
        return done(err, null)

      stdout = stdout.split(os.EOL)[1]
      stdout = stdout.replace(/^\s+/, '').replace(/\s\s+/g, ' ').split(' ')

      return done(null, {
        cpu: parseFloat(stdout[0].replace(',', '.')),
        memory: parseFloat(stdout[1]) * 1024
      })
    })
  },
  /**
   * This is really in a beta stage
   */
  win: function(pid, options, done) {
    // The code is tested under:
    // Windows 7 Ultimate/Enterprise SP1 64bit
    // Windows 8.1 Enterprise SP1 64bit
    // Windows 10 Professonal 64bit
    // Windows Server 2008 R2 64bit
    // Windows Server 2012 R2 64bit

    // Ref:
    // https://msdn.microsoft.com/en-us/library/aa394277(v=vs.85).aspx

    var args = 'path Win32_PerfRawData_PerfProc_Process WHERE IDProcess=' + pid + ' get PercentProcessorTime, TimeStamp_Sys100NS, WorkingSet'
    var wmic = spawn('wmic', args.split(' '), {detached: true})
    var stdout = ''
    var stderr = ''
    var self = this

    wmic.stdout.on('data', function(d) {
     stdout += d.toString()
    })

    wmic.stderr.on('data', function(d) {
      stderr += d.toString()
    })

    wmic.on('error', function(err) {
      console.error('[pidusage] Command "wmic ' + args + '" failed with error %s', err)
    })

    wmic.on('close', function(code) {
      stdout = stdout.trim()
      stderr = stderr.trim()

      if(!stdout || code !== 0) {
        var error = util.format('%s Wmic errored, please open an issue on https://github.com/soyuka/pidusage with this message.%s', new Date().toString(), os.EOL)
        error += format('Command was "wmic %s"%s', args, os.EOL)
        stderr = error + (stderr ? format('Wmic reported the following error: %s.', stderr) : 'Wmic reported no errors.')
        stderr = format('%s%s%s Wmic exited with code %d.%s', os.EOL, stderr, os.EOL, code, os.EOL)
        stdout ? stderr = format('%s%s Stdout was %s', stderr, os.EOL, stdout) : null

        return done(new Error(stderr , null))
      }

      // The new line in Windows is '\r\r\n'
      var lines = stdout.split(/\r?\r\n/)
      // We might need the titles someday.
      //var titles = lines[0].trim().split( / +/ )
      var values = lines[1].trim().split(/ +/)
      var cpuPercent = parseFloat(values[0])
      var cpuTime = parseFloat(values[1])
      var cpu = 0
      var memUsage   = parseFloat(values[2])

      //https://msdn.microsoft.com/en-us/library/aa394597(v=vs.85).aspx
      //https://msdn.microsoft.com/en-us/library/ms974615.aspx

      if (self.history[pid] !== undefined) {
        var history = self.history[pid]
        if (cpuTime - history.cpuTime === 0) {
          cpu = 0
        } else {
          cpu = 100 - (100 * (1 - (cpuPercent - history.cpuPercent)/(cpuTime - history.cpuTime)))
        }
      } else {
        cpu = 100 - (100 * (1 - cpuPercent/cpuTime))
      }

      self.history[pid] = {
        cpuTime: cpuTime,
        cpuPercent: cpuPercent
      }

      return done(null, {cpu : cpu, memory : memUsage})
    })
  }
}

module.exports = stats;
